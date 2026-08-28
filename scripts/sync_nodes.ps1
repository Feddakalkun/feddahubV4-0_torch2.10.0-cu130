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
        return Invoke-Git @("-C", $Dir, "checkout", "-q", $Pin)
    }
    $r = Invoke-Git @("-C", $Dir, "checkout", "-q", "FETCH_HEAD")
    if ($r.Code -ne 0) { return $r }
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

Write-Host ""
Write-Host "  Custom nodes -> $($Nodes.Count) pinned pack(s)" -ForegroundColor Cyan

foreach ($node in $Nodes) {
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

    Write-Host "   -> $($node.folder) $verb $($pin.Substring(0, 12))" -ForegroundColor Gray
    $r = Set-NodeToPin -Dir $dir -Url $node.url -Pin $pin
    if ($r.Code -ne 0) {
        Write-Host "      FAILED" -ForegroundColor Red
        $tail = @($r.Output -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
        foreach ($t in $tail) { Write-Host "      $("$t".Trim())" -ForegroundColor DarkRed }
        $Notes += "$($node.folder) : git failed"
        $Failed++
        continue
    }
    Install-NodeRequirements -Dir $dir -Name $node.folder
    if ($have) { $Updated++ } else { $Installed++ }
}

Write-Host ""
$color = "Green"
if ($Failed -gt 0) { $color = "Red" } elseif ($Manual -gt 0) { $color = "Yellow" }
Write-Host ("  Nodes: {0} installed, {1} updated, {2} already at pin, {3} manual, {4} failed" -f `
            $Installed, $Updated, $Current, $Manual, $Failed) -ForegroundColor $color
foreach ($n in $Notes) { Write-Host "    - $n" -ForegroundColor DarkYellow }

if ($Failed -gt 0) { exit 1 }
exit 0
