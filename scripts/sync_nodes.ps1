<#
    Bring ComfyUI's custom_nodes to exactly what config/nodes.json pins.

    v3 installed a node pack once and never looked at it again - the whole of
    its logic was `if (-not (Test-Path $NodeDir)) { clone } else { skip }`.
    Two things follow from that, and both are bad for an app meant to keep
    getting better:

      * a fix upstream never reaches anyone who already installed
      * what you have depends on the week you installed, so two machines
        running "the same version" are not running the same code

    This runs at install time and again on every update, and it is the same
    operation both times: make the folder match the pin. A pin that moves in
    the repository is therefore a pin that moves on every machine, which is
    what lets the node set be maintained at all rather than frozen.

    Bypass is the point of a pin, not a limitation of one: pins are chosen by
    harvesting an install that demonstrably works (scripts/harvest_pins.py),
    so moving one is a deliberate act with a reference behind it.
#>
param(
    [Parameter(Mandatory = $true)][string] $ComfyDir,
    [string] $NodesJson,
    [string] $VenvPython,
    [switch] $DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path $PSScriptRoot -Parent
if (-not $NodesJson) { $NodesJson = Join-Path $RepoRoot "config\nodes.json" }

$CustomNodes = Join-Path $ComfyDir "custom_nodes"
if (-not (Test-Path $CustomNodes)) { New-Item -ItemType Directory -Force $CustomNodes | Out-Null }

$Nodes = Get-Content $NodesJson -Raw -Encoding UTF8 | ConvertFrom-Json
$Installed = 0; $Updated = 0; $Current = 0; $Failed = 0; $Manual = 0
$Notes = @()

function Invoke-Git {
    param([string[]] $Arguments)
    $ErrorActionPreference = "Continue"
    $out = & git @Arguments 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    return [pscustomobject]@{ Code = $code; Output = $out }
}

function Set-NodeToPin {
    <# Fetch just the pinned commit and sit on it. A shallow fetch of one sha
       is a fraction of a clone, and it is the only form that works for a
       commit which is not the tip of a branch. #>
    param([string] $Dir, [string] $Url, [string] $Pin)

    if (-not (Test-Path (Join-Path $Dir ".git"))) {
        New-Item -ItemType Directory -Force $Dir | Out-Null
        $r = Invoke-Git @("init", "-q", $Dir);            if ($r.Code -ne 0) { return $r }
        $r = Invoke-Git @("-C", $Dir, "remote", "add", "origin", $Url)
        if ($r.Code -ne 0) { return $r }
    }
    $r = Invoke-Git @("-C", $Dir, "fetch", "-q", "--depth", "1", "origin", $Pin)
    if ($r.Code -ne 0) {
        # Some servers refuse to serve an arbitrary sha. Pay for the history.
        $r = Invoke-Git @("-C", $Dir, "fetch", "-q", "origin")
        if ($r.Code -ne 0) { return $r }
        $r = Invoke-Git @("-C", $Dir, "checkout", "-q", $Pin)
    } else {
        $r = Invoke-Git @("-C", $Dir, "checkout", "-q", "FETCH_HEAD")
    }
    if ($r.Code -ne 0) { return $r }

    # Both paths land here. This used to sit only after the shallow
    # checkout, so a pack that needed the full-history fallback - the only
    # reason that branch exists - got no submodules at all, installed
    # looking fine and failed when ComfyUI imported it.
    return Invoke-Git @("-C", $Dir, "submodule", "update", "--init", "--recursive", "--depth", "1")
}

function Install-NodeRequirements {
    param([string] $Dir, [string] $Name)
    if (-not $VenvPython) { return }
    $req = Join-Path $Dir "requirements.txt"
    if (-not (Test-Path $req)) { return }
    $ErrorActionPreference = "Continue"
    $out = & $VenvPython -m pip install -r $req --no-warn-script-location --quiet 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    if ($code -ne 0) {
        Write-Host "      deps FAILED - $Name may not load" -ForegroundColor Yellow
        $why = @($out | Where-Object { "$_" -match '^\s*(ERROR|error:)' } | Select-Object -Last 1)
        foreach ($w in $why) { Write-Host "      $("$w".Trim())" -ForegroundColor DarkYellow }
        $script:Notes += "$Name : requirements failed"
    }
}

# Sixty identical lines with no position in them is several minutes of not
# knowing how far along you are. A bar answers where; the estimate answers
# how much longer, which is the part somebody watching actually wants. The
# catalog holds 60 packs and the full profile installs boosters, so this is
# not a one-workflow concern.
#
# The estimate counts only packs that did network work. Most of an update is
# folders already on their pin, which finish in a local rev-parse; letting
# those into the average would predict a finish that has already happened.
#
# The rate is measured off disk, because git reports nothing usable about
# bytes. Each folder is sized once it is there and added to a running total,
# which makes it the throughput of the whole step - clones and the pip
# wheels that follow them alike - and the number that actually predicts the
# finish rather than the network at its best.
function Show-NodeProgress {
    param([int] $Done, [int] $Total, [int] $Worked, [string] $Name,
          [System.Diagnostics.Stopwatch] $Clock, [double] $Bytes = 0)

    $filled = [int](20 * $Done / [Math]::Max($Total, 1))
    $bar = ("#" * $filled) + ("-" * (20 - $filled))
    $el = $Clock.Elapsed

    # Blank rather than a wrong number until three packs have really done
    # something. Timings are lumpy - rgthree clones in three seconds,
    # ComfyUI-Manager takes twenty - so the first estimates are noise.
    $eta = "   --:--"
    if ($Worked -ge 3 -and $el.TotalSeconds -gt 0) {
        $per = $el.TotalSeconds / $Worked
        $left = [TimeSpan]::FromSeconds($per * ($Total - $Done))
        $eta = "ETA {0:00}:{1:00}" -f [int]$left.TotalMinutes, $left.Seconds
    }

    # Padded to the same width when there is nothing to report, so the name
    # column does not jump about between lines.
    $rate = "          "
    if ($Bytes -gt 0 -and $el.TotalSeconds -gt 1) {
        $rate = "{0,5:N1} MB/s" -f (($Bytes / 1MB) / $el.TotalSeconds)
    }

    Write-Host ("   [{0,2}/{1}] {2} {3:mm\:ss} {4} {5}  {6}" -f `
                $Done, $Total, $bar, $el, $eta, $rate, $Name) -ForegroundColor Gray
}

Write-Host ""
Write-Host "  Custom nodes -> $($Nodes.Count) pinned pack(s)" -ForegroundColor Cyan

$Index = 0
$Worked = 0
$Total = $Nodes.Count
$Clock = [System.Diagnostics.Stopwatch]::StartNew()
$SeenBytes = 0.0

foreach ($node in $Nodes) {
    $Index++
    $dir = Join-Path $CustomNodes $node.folder
    $pin = "$($node.pin)"

    if (-not $pin) {
        Write-Host "   ?  $($node.folder) - no pin, skipped" -ForegroundColor Yellow
        $Notes += "$($node.folder) : no pin in nodes.json"
        $Manual++
        continue
    }

    $have = ""
    if (Test-Path (Join-Path $dir ".git")) {
        $r = Invoke-Git @("-C", $dir, "rev-parse", "HEAD")
        if ($r.Code -eq 0) { $have = $r.Output.Trim() }
    } elseif (Test-Path $dir) {
        # Present but not a checkout - someone installed it by hand or through
        # ComfyUI Manager's registry path. Replacing that silently would throw
        # away whatever they meant to do, so it is reported and left alone.
        Write-Host "   !  $($node.folder) - present, not a git checkout; left alone" -ForegroundColor Yellow
        $Notes += "$($node.folder) : installed outside FEDDA, pin not enforced"
        $Manual++
        continue
    }

    if ($have -and $have.StartsWith($pin)) { $Current++; continue }

    $verb = "install"
    if ($have) { $verb = "update" }
    if ($DryRun) {
        Write-Host "   ~  $($node.folder) would $verb -> $($pin.Substring(0, 12))" -ForegroundColor DarkGray
        continue
    }

    $Worked++
    Show-NodeProgress -Done $Index -Total $Total -Worked $Worked `
        -Name "$($node.folder) $verb $($pin.Substring(0, 12))" `
        -Clock $Clock -Bytes $SeenBytes
    $r = Set-NodeToPin -Dir $dir -Url $node.url -Pin $pin
    if ($r.Code -ne 0) {
        Write-Host "      FAILED" -ForegroundColor Red
        $tail = @($r.Output -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
        foreach ($t in $tail) { Write-Host "      $("$t".Trim())" -ForegroundColor DarkRed }
        $Notes += "$($node.folder) : git failed"
        $Failed++
        continue
    }
    try {
        $SeenBytes += (Get-ChildItem $dir -Recurse -File -Force -ErrorAction SilentlyContinue |
                       Measure-Object Length -Sum).Sum
    } catch { }
    Install-NodeRequirements -Dir $dir -Name $node.folder
    if ($have) { $Updated++ } else { $Installed++ }
}

Write-Host ""
$color = "Green"
if ($Failed -gt 0) { $color = "Red" } elseif ($Manual -gt 0) { $color = "Yellow" }
$Summary = "{0} installed, {1} updated, {2} already at pin, {3} manual, {4} failed" -f `
           $Installed, $Updated, $Current, $Manual, $Failed
Write-Host "  Nodes: $Summary" -ForegroundColor $color
foreach ($n in $Notes) { Write-Host "    - $n" -ForegroundColor DarkYellow }

# Written down as well as printed. This runs in its own powershell process,
# so install.ps1 cannot see these counters - and its report said
# "Node packs:  installed,  already present,  failed" with every number
# missing until this file existed. update_logic wants the same line.
try {
    $LogDir = Join-Path $RepoRoot "logs"
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force $LogDir | Out-Null }
    $Report = $Summary
    foreach ($n in $Notes) { $Report += "`n  - $n" }
    Set-Content -Path (Join-Path $LogDir "node_sync.txt") -Value $Report -Encoding utf8
} catch { }

if ($Failed -gt 0) { exit 1 }
exit 0
