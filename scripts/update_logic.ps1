# ============================================================================
# FEDDA Update & Repair - auto-detects portable vs lite mode
# ============================================================================

param([switch]$SilentMode)

# Never let git pause for input (merge editor / pager / auth prompt). A diverged
# custom-node repo doing `git pull` was opening an editor and freezing the update.
$env:GIT_PAGER = 'cat'
$env:GIT_EDITOR = 'true'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'

$ErrorActionPreference = "Stop"

<#
    Apply a custom node's repair_dependency_list.txt ourselves instead of
    running its repair_dependency.bat.

    LayerStyle's script froze every update: it ends in `pause`, so an automated
    run waits forever for a keypress nobody is there to give. It also installs
    from a Chinese PyPI mirror, which from Europe is slow enough to look like a
    second hang, and it uninstalls onnxruntime without ever reinstalling it -
    taking out a package controlnet_aux and ReActor both need.

    So: same intent, none of that. The list is installed from the default
    index, conflicting opencv builds are cleared first because having several
    side by side is the actual problem these scripts exist to fix, and
    onnxruntime is left alone.
#>
<#
    Run pip without Windows PowerShell dressing its stderr up as failures.

    `& python -m pip ... 2>&1` turns every warning pip writes to stderr into an
    ErrorRecord, so a normal update scrolls past red "NativeCommandError" blocks
    about resolver conflicts that are not errors at all - it looks like the
    update is failing when it is doing exactly what it should. Piping through
    Out-String keeps the text and drops the pretence.
#>
function Invoke-Pip {
    param([string]$PyExe, [string[]]$PipArgs, [string]$Label = "pip")
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        # Captured, not printed. A failed source build answers with ninety
        # lines of compiler output, and an update that touches forty nodes
        # buries its own progress in them - which is what the console looked
        # like before this. The detail still exists, in logs\update_pip.log.
        #
        # 2>&1 is safe now that the result goes into Out-String: the
        # ErrorRecords PowerShell wraps stderr in are rendered as their own
        # text there, so none of them reach the console as red blocks. That
        # wrapping, not the redirection itself, was the original complaint.
        $out = & $PyExe @PipArgs 2>&1 | Out-String
        $code = $LASTEXITCODE
        if ($script:PipDetailLog) {
            Add-Content -LiteralPath $script:PipDetailLog -ErrorAction SilentlyContinue `
                -Value ("`r`n===== $Label =====`r`n" + $out)
        }
        return $code
    } finally {
        $ErrorActionPreference = $prev
    }
}


function Invoke-NodeDependencyRepair {
    param(
        [string]$NodeDir,
        [string]$NodeName,
        [string]$PyExe
    )
    $list = Join-Path $NodeDir "repair_dependency_list.txt"
    if (-not (Test-Path $list)) { return }

    $pkgs = Get-Content $list | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") }
    if (-not $pkgs) { return }

    Write-Host "  [$NodeName] Repairing dependencies ($($pkgs.Count))..." -ForegroundColor Gray
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        if ($pkgs -match "opencv") {
            & $PyExe -s -m pip uninstall -y opencv-python opencv-contrib-python `
                opencv-python-headless opencv-contrib-python-headless 2>&1 | Out-Null
        }
        foreach ($p in $pkgs) {
            & $PyExe -s -m pip install --no-input --no-warn-script-location "$p" 2>&1 | Out-Null
        }
    } catch {
        Write-Host "  [$NodeName] Dependency repair failed - continuing." -ForegroundColor DarkYellow
    } finally {
        $ErrorActionPreference = $prev
    }
}
$ScriptPath = $PSScriptRoot
$RootPath = Split-Path -Parent $ScriptPath
Set-Location $RootPath

# Start transcript only when run standalone (update_code.ps1 owns it when calling us)
$LogDir = Join-Path $RootPath "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir "update.log"
# Where Invoke-Pip puts the output it no longer prints. Separate from update.log
# so the readable account of the run stays readable.
$script:PipDetailLog = Join-Path $LogDir "update_pip.log"
Set-Content -LiteralPath $script:PipDetailLog -Value "FEDDA update - pip detail - $(Get-Date)" -ErrorAction SilentlyContinue
$script:PipFailures = @()
if (-not $FeddaTranscriptOwner) {
    try { Start-Transcript -Path $LogFile -Append -Force | Out-Null } catch {}
}

if (-not $SilentMode) {
    Write-Host "===================================================" -ForegroundColor Cyan
    Write-Host "      FEDDA UPDATE & REPAIR" -ForegroundColor Cyan
    Write-Host "===================================================" -ForegroundColor Cyan
}

# ============================================================================
# DETECT MODE
# ============================================================================
$PortablePy = Join-Path $RootPath "python_embeded\python.exe"
$VenvPy     = Join-Path $RootPath "venv\Scripts\python.exe"
$NodeEmbed  = Join-Path $RootPath "node_embeded\node.exe"
$ComfyDir = Join-Path $RootPath "ComfyUI"
$CustomNodesDir = Join-Path $ComfyDir "custom_nodes"

# Detection order: venv = Lite (even if python_embeded also exists, since
# Lite now embeds Python 3.11.9 but still creates a venv from it).
# Full/portable = has python_embeded AND node_embeded (no venv).
if (Test-Path $VenvPy) {
    $Mode = "lite"
    $PyExe = $VenvPy
    if (-not $SilentMode) { Write-Host "`n  Mode: Lite (venv)" -ForegroundColor Green }
} elseif ((Test-Path $PortablePy) -and (Test-Path $NodeEmbed)) {
    $Mode = "portable"
    $PyExe = $PortablePy
    if (-not $SilentMode) { Write-Host "`n  Mode: Full (portable)" -ForegroundColor Green }
} elseif (Test-Path $PortablePy) {
    # python_embeded only, no venv and no node_embeded - treat as portable
    $Mode = "portable"
    $PyExe = $PortablePy
    if (-not $SilentMode) { Write-Host "`n  Mode: Full (portable - no node_embeded)" -ForegroundColor Yellow }
} else {
    Write-Host "`n  [ERROR] No Python environment found!" -ForegroundColor Red
    Write-Host "  Run install.bat first." -ForegroundColor Yellow
    exit 1
}

# Git setup
$GitEmbedded = Join-Path $RootPath "git_embeded\cmd\git.exe"
if (Test-Path $GitEmbedded) {
    $GitExe = $GitEmbedded
    $env:PATH = "$(Split-Path $GitExe);$env:PATH"
} else {
    $GitExe = "git"
}

# Fix dubious ownership errors (local config only - never modify user's global gitconfig)
$env:GIT_CONFIG_GLOBAL = Join-Path $RootPath ".gitconfig"
& $GitExe config --file "$env:GIT_CONFIG_GLOBAL" --add safe.directory '*' 2>$null

if (-not (Test-Path $ComfyDir)) {
    Write-Host "`n  [ERROR] ComfyUI directory not found!" -ForegroundColor Red
    Write-Host "  Run install.bat first." -ForegroundColor Yellow
    exit 1
}

# ============================================================================
# 0. UPDATE COMFYUI CORE
# ============================================================================
# ---------------------------------------------------------------------------
# PyTorch generation migration: cu124 -> cu130
# ---------------------------------------------------------------------------
# cu124 receives no torch newer than 2.6.0, and ComfyUI has needed newer than
# that since 0.32. An install left on cu124 is stuck on ComfyUI v0.18.1, which
# has no MiniMax H3 nodes, no QuadrupleCLIPLoader and none of the Ideogram core
# nodes - six MiniMax workflows were registered here and could never run.
#
# Verified on a 3090 with this node set before shipping: node classes the audit
# could not find went from 14 to 1, and failed custom-node imports from 7 to 5.
#
# Runs once. An install already on cu130 skips the whole block.
$ErrorActionPreference = "Continue"
$TorchNow = & $PyExe -c "import torch; print(torch.__version__)" 2>$null
if ($TorchNow -and $TorchNow -match "\+cu124") {
    Write-Host "`n[0/3] Moving PyTorch to CUDA 13.0 (one-time, several minutes)..." -ForegroundColor Yellow
    Write-Host "  cu124 stopped at torch 2.6 and current ComfyUI will not start on it." -ForegroundColor DarkGray
    $TorchWas = $TorchNow.Trim()

    # xformers first, and it does not come back. It is the reason triton had to
    # be pinned, ComfyUI uses pytorch attention without it, and leaving it
    # installed against a torch it was not built for breaks every import of
    # diffusers.
    Invoke-Pip -PyExe $PyExe -Label "remove xformers" `
        -PipArgs @("-m","pip","uninstall","-y","xformers") | Out-Null

    Invoke-Pip -PyExe $PyExe -Label "torch 2.10.0+cu130" `
        -PipArgs @("-m","pip","install","torch==2.10.0+cu130","torchvision==0.25.0+cu130",
                   "torchaudio==2.10.0+cu130","--index-url","https://download.pytorch.org/whl/cu130",
                   "--no-warn-script-location") | Out-Null

    Invoke-Pip -PyExe $PyExe -Label "triton-windows" `
        -PipArgs @("-m","pip","install","triton-windows==3.6.0.post26","--no-warn-script-location") | Out-Null

    # Both, because a torch that imports but cannot see the card is not a
    # working install - it is a silent fallback to CPU.
    $TorchOk = & $PyExe -c "import torch; print('ok' if torch.cuda.is_available() else 'nocuda')" 2>$null
    if ($TorchOk -and $TorchOk.Trim() -eq "ok") {
        Write-Host "  PyTorch 2.10.0+cu130 installed and the GPU is visible." -ForegroundColor Green

        # sm_80 and up, so 30-series and newer. The published wheel matches this
        # torch; plain `pip install sageattention` builds from source and fails
        # on a machine with no compiler.
        try {
            $GPUName = (Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match "NVIDIA" } | Select-Object -First 1).Name
            if ($GPUName -match "RTX (30|40|50)\d\d") {
                $SageWheel = "https://github.com/woct0rdho/SageAttention/releases/download/v2.2.0-windows.post5/" +
                             "sageattention-2.2.0%2Bcu130torch2.10.0andhigher.post5-cp310-abi3-win_amd64.whl"
                Invoke-Pip -PyExe $PyExe -Label "sageattention" `
                    -PipArgs @("-m","pip","install",$SageWheel,"--no-warn-script-location") | Out-Null
            }
        } catch { }
    } else {
        Write-Host "  [WARN] The new PyTorch does not work here - putting $TorchWas back." -ForegroundColor Yellow
        Write-Host "  This downloads the old wheels again and takes a few minutes." -ForegroundColor DarkGray
        $OldVer = $TorchWas -replace '\+.*$', ''
        Invoke-Pip -PyExe $PyExe -Label "torch rollback" `
            -PipArgs @("-m","pip","install","torch==$OldVer+cu124","--index-url",
                       "https://download.pytorch.org/whl/cu124","--no-warn-script-location") | Out-Null
        Write-Host "  FEDDA still runs on the old PyTorch; the newer workflows wait." -ForegroundColor Yellow
    }
}
$ErrorActionPreference = "Stop"

Write-Host "`n[1/3] Updating ComfyUI core..." -ForegroundColor Yellow
try {
    Set-Location $ComfyDir
    $ErrorActionPreference = "Continue"
    # A pin, not master. Tracking master meant two people on the same FEDDA
    # release could be a dozen ComfyUI versions apart, and it is why an update
    # could silently land on a version the installed torch cannot start.
    # v0.33.1 is the version verified against torch 2.10 with this node set.
    #
    # Recorded as a hash because the install leaves ComfyUI on a detached HEAD.
    $ComfyPin = "v0.33.1"
    $ComfyWas = (& $GitExe rev-parse HEAD 2>$null)
    & $GitExe fetch --tags origin 2>&1 | Out-Null
    & $GitExe checkout $ComfyPin 2>&1 | Out-Null
    $ErrorActionPreference = "Stop"
    Set-Location $RootPath

    # Does it still start? Newer ComfyUI needs a newer torch than the cu124
    # channel can give a 20/30/40-series card, and today's update left the app
    # dead on exactly that: master calls comfy_kitchen.int8_attention_is_available,
    # which the installable comfy-kitchen for torch 2.6 does not have.
    #
    # comfy.ldm.modules.attention, not comfy.utils. utils was tried first and
    # passed while the app was broken - the failing call is in attention, and
    # utils never reaches it.
    # Continue: importing ComfyUI can warn, and a warning on stderr
    # becomes a NativeCommandError under Stop. Only the exit code counts.
    $ErrorActionPreference = "Continue"
    & $PyExe -c "import sys; sys.path.insert(0, r'$ComfyDir'); import comfy.model_base, comfy.ldm.modules.attention" 2>$null | Out-Null
    $ProbeExit = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    $global:LASTEXITCODE = $ProbeExit
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ComfyUI core at $ComfyPin." -ForegroundColor Green
    } elseif ($ComfyWas) {
        Write-Host "  [WARN] The newer ComfyUI will not start on this PyTorch - going back." -ForegroundColor Yellow
        $ErrorActionPreference = "Continue"
        Set-Location $ComfyDir
        & $GitExe reset --hard $ComfyWas 2>&1 | Out-Null
        $ErrorActionPreference = "Stop"
        Set-Location $RootPath
        # Continue: importing ComfyUI can warn, and a warning on stderr
        # becomes a NativeCommandError under Stop. Only the exit code counts.
        $ErrorActionPreference = "Continue"
        & $PyExe -c "import sys; sys.path.insert(0, r'$ComfyDir'); import comfy.model_base, comfy.ldm.modules.attention" 2>$null | Out-Null
        $ProbeExit = $LASTEXITCODE
        $ErrorActionPreference = "Stop"
        $global:LASTEXITCODE = $ProbeExit
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ComfyUI restored to the version that runs here. FEDDA still works;" -ForegroundColor Yellow
            Write-Host "  newer ComfyUI features wait on a PyTorch upgrade." -ForegroundColor DarkGray
        } else {
            Write-Host "  [WARN] ComfyUI still will not start - see logs\comfyui_live.err.log." -ForegroundColor Red
        }
    } else {
        Write-Host "  [WARN] ComfyUI will not start and there was nothing to go back to." -ForegroundColor Red
    }
} catch {
    Set-Location $RootPath
    Write-Host "  [WARNING] ComfyUI core update failed (non-fatal): $_" -ForegroundColor Yellow
}

# ============================================================================
# 1. CUSTOM NODES - install missing / update existing (from nodes.json)
# ============================================================================
# ---------------------------------------------------------------------------
# What this update needs, decided from what it changed.
#
# update_code.ps1 writes logs\.update_changed.txt: the paths between the commit
# before the pull and the one after. The three expensive steps below are only
# required by two kinds of change; anything else is a code update, and the code
# is already on disk by the time this runs.
#
# The three states are different on purpose:
#   file missing   -> could not tell, so do everything (what shipped before)
#   file empty     -> nothing changed, so do nothing expensive
#   file has paths -> do what those paths imply
#
# Missing has to mean "everything". Reading it as "nothing" would turn any
# failure to compute the diff into an update that quietly skips its own work,
# which is the failure this project keeps finding.
$FeddaRepair = ($env:FEDDA_REPAIR -eq "1")
$ChangedFile = Join-Path $RootPath "logs\.update_changed.txt"
$ChangedKnown = Test-Path $ChangedFile
$Changed = @()
if ($ChangedKnown) {
    $Changed = @(Get-Content $ChangedFile -ErrorAction SilentlyContinue |
                 ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Test-FeddaTouched {
    <#
        Did this update touch anything matching these patterns? True when the
        change set is unknown, so an unreadable diff costs a slower update
        rather than a skipped one.
    #>
    param([string[]]$Patterns)
    if ($FeddaRepair -or -not $ChangedKnown) { return $true }
    foreach ($p in $Patterns) {
        if ($Changed | Where-Object { $_ -like $p }) { return $true }
    }
    return $false
}

$NeedPip = Test-FeddaTouched @("scripts/install.ps1", "scripts/update_logic.ps1",
                               "*requirements*.txt")
$NeedFrontend = Test-FeddaTouched @("frontend/package.json",
                                    "frontend/package-lock.json")

if ($FeddaRepair) {
    Write-Host "`n  Repair run - every step, whatever changed." -ForegroundColor Yellow
} elseif ($ChangedKnown) {
    if ($Changed.Count -eq 0) {
        Write-Host "`n  Code is already current." -ForegroundColor Green
    } else {
        $Skipped = @()
        if (-not $NeedPip)      { $Skipped += "python deps" }
        if (-not $NeedFrontend) { $Skipped += "frontend deps" }
        Write-Host ("`n  {0} file(s) changed. Skipping: {1}" -f $Changed.Count,
                    $(if ($Skipped) { $Skipped -join ", " } else { "nothing" })) `
            -ForegroundColor DarkGray
    }
}

# config/nodes.json is derived by scripts/require_nodes.py from the workflows
# this install actually ships, and every pack in it carries a commit taken
# from an install known to work. sync_nodes.ps1 puts each folder on exactly
# that commit - the same call, with the same meaning, that install.ps1 step 4
# makes. One operation for both, deliberately.
#
# It runs unconditionally, and that is the point. What stood here was v3's
# `if (-not (Test-Path $NodeDir)) { clone } else { skip }`: a pack installed
# once was never touched again, so a fix upstream reached nobody who had
# already run the installer. Nothing brakes it now - a folder already on its
# pin costs one local `git rev-parse` and is skipped inside the script, which
# is cheap enough that guessing is not worth the risk of guessing wrong.
#
# Gone with it: the weekly .last_node_update marker, and the $CriticalNodes
# list that force-pulled three packs to HEAD on every update. Both existed
# because v3 cloned at HEAD and had to keep pulling. Pinned, "check again in
# seven days" answers a question nobody asks - the folder either matches the
# pin or it does not - and pulling to HEAD is the drift pinning prevents.
Write-Host "`n[1/3] Custom nodes" -ForegroundColor Yellow
$SyncNodes = Join-Path $RootPath "scripts\sync_nodes.ps1"
& powershell -NoProfile -ExecutionPolicy Bypass -File $SyncNodes `
    -ComfyDir $ComfyDir -VenvPython $PyExe
if ($LASTEXITCODE -ne 0) {
    # Not fatal, for the same reason as at install time: a failed pack means
    # the workflows using it will not open and the report above names it, but
    # the python deps and the frontend are still worth finishing.
    Write-Host "  One or more node packs failed - see the report above" -ForegroundColor Yellow
}

# ============================================================================
# 1b. PATCH PYTHON DEPENDENCIES - fix known version conflicts
# ============================================================================
if (-not $NeedPip) {
    Write-Host "`n[1b/3] Python dependencies unchanged by this update" -ForegroundColor Green
} else {
Write-Host "`n[1b/3] Patching Python dependencies..." -ForegroundColor Yellow

# ComfyUI pins a handful of packages with == because its own code calls into
# them by exact signature. comfy-kitchen is the one that bites: core called
# rms_rope_split_half_(..., rot_dim=...) against an installed build that had no
# such parameter, and every MiniMax run died on a TypeError that named neither
# ComfyUI nor pip.
#
# Only the == lines are synced. The >= and bare entries are left alone on
# purpose - torch and transformers live there, and dragging those along turns a
# version fix into a torch generation swap nobody asked for.
$ComfyReq = Join-Path (Join-Path $RootPath "ComfyUI") "requirements.txt"
if (Test-Path $ComfyReq) {
    $Pinned = Get-Content $ComfyReq | Where-Object { $_ -match '^[A-Za-z0-9._-]+==' } | ForEach-Object { $_.Trim() }
    $Stale = @()
    foreach ($Pin in $Pinned) {
        $Name, $Want = $Pin -split '==', 2
        # Continue: a warning on stderr becomes a NativeCommandError under
        # Stop, and this probe is judged by its exit code, not by that.
        $ErrorActionPreference = "Continue"
        $Have = & $PyExe -c "import importlib.metadata as m; print(m.version('$Name'))" 2>$null
        $ProbeExit = $LASTEXITCODE
        $ErrorActionPreference = "Stop"
        $global:LASTEXITCODE = $ProbeExit
        if ($LASTEXITCODE -ne 0 -or -not $Have) { $Stale += $Pin; continue }
        if ($Have.Trim() -ne $Want.Trim()) { $Stale += $Pin }
    }
    if ($Stale.Count -gt 0) {
        Write-Host "  Syncing $($Stale.Count) pinned ComfyUI dependencies..." -ForegroundColor White
        foreach ($Pin in $Stale) { Write-Host "    $Pin" -ForegroundColor DarkGray }

        # What is being replaced, so it can be put back. A pin is only an
        # improvement if ComfyUI still starts afterwards, and one of these
        # already did not: master pins comfy-kitchen 0.2.31, which types a
        # custom op `list[int]`, and torch 2.6 rejects PEP 585 generics - so
        # `import comfy.utils` failed outright where 0.2.26 had imported with
        # fp8 and fp4 turned off. A missing feature beats a dead install.
        $Previous = @{}
        foreach ($Pin in $Stale) {
            $Name = ($Pin -split '==', 2)[0]
            # Continue: a warning on stderr becomes a NativeCommandError under
            # Stop, and this probe is judged by its exit code, not by that.
            $ErrorActionPreference = "Continue"
            $Was = & $PyExe -c "import importlib.metadata as m; print(m.version('$Name'))" 2>$null
            $ProbeExit = $LASTEXITCODE
            $ErrorActionPreference = "Stop"
            $global:LASTEXITCODE = $ProbeExit
            if ($LASTEXITCODE -eq 0 -and $Was) { $Previous[$Name] = $Was.Trim() }
        }

        Invoke-Pip -PyExe $PyExe -Label "ComfyUI pins" `
            -PipArgs (@("-m","pip","install","--no-input","--no-warn-script-location") + $Stale) | Out-Null

        # Ask ComfyUI itself. Nothing here knows which package is risky; any
        # pin that cannot run on the installed torch fails the same check.
        $ComfyDirCheck = Join-Path $RootPath "ComfyUI"
        # Continue: importing ComfyUI can warn, and a warning on stderr
        # becomes a NativeCommandError under Stop. Only the exit code counts.
        $ErrorActionPreference = "Continue"
        & $PyExe -c "import sys; sys.path.insert(0, r'$ComfyDirCheck'); import comfy.model_base, comfy.ldm.modules.attention" 2>$null | Out-Null
        $ProbeExit = $LASTEXITCODE
        $ErrorActionPreference = "Stop"
        $global:LASTEXITCODE = $ProbeExit
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ComfyUI pins synced OK" -ForegroundColor Green
        } else {
            Write-Host "  [WARN] ComfyUI could not start with the new pins - putting them back." -ForegroundColor Yellow
            $Restore = @()
            foreach ($Name in $Previous.Keys) { $Restore += "$Name==$($Previous[$Name])" }
            if ($Restore.Count -gt 0) {
                foreach ($R in $Restore) { Write-Host "    $R" -ForegroundColor DarkGray }
                Invoke-Pip -PyExe $PyExe -Label "ComfyUI pin rollback" `
                    -PipArgs (@("-m","pip","install","--no-input","--no-warn-script-location") + $Restore) | Out-Null
                # Continue: importing ComfyUI can warn, and a warning on stderr
                # becomes a NativeCommandError under Stop. Only the exit code counts.
                $ErrorActionPreference = "Continue"
                & $PyExe -c "import sys; sys.path.insert(0, r'$ComfyDirCheck'); import comfy.model_base, comfy.ldm.modules.attention" 2>$null | Out-Null
                $ProbeExit = $LASTEXITCODE
                $ErrorActionPreference = "Stop"
                $global:LASTEXITCODE = $ProbeExit
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "  Restored. ComfyUI starts; a feature the new pin adds is unavailable." -ForegroundColor Yellow
                } else {
                    Write-Host "  [WARN] Still failing after restore - see logs\update_pip.log." -ForegroundColor Red
                }
            } else {
                Write-Host "  [WARN] Nothing recorded to restore - see logs\update_pip.log." -ForegroundColor Red
            }
        }
    } else {
        Write-Host "  ComfyUI pinned dependencies OK" -ForegroundColor Green
    }
}


# The embeddable distribution ships no C headers and no import library, so
# anything that has to be compiled fails on "Cannot open include file:
# 'Python.h'" - which reads like a broken toolchain and is not. install.ps1 adds
# them, but only on a fresh install, so every machine set up before that step
# existed is still missing them. triton's runtime compiles a CUDA helper at
# startup and is one of the things that fails without them.
$IncDir = Join-Path $RootPath "python_embeded\Include"
$LibDir = Join-Path $RootPath "python_embeded\libs"
if (-not (Test-Path (Join-Path $IncDir "Python.h"))) {
    Write-Host "  Adding Python headers (needed to compile C extensions)..." -ForegroundColor White
    try {
        $NuPkg = Join-Path $RootPath "python_nuget.zip"
        $NuDir = Join-Path $RootPath "_python_nuget"
        & curl.exe -L -s -o "$NuPkg" "https://www.nuget.org/api/v2/package/python/3.11.9" --retry 3 --retry-delay 2
        if ($LASTEXITCODE -ne 0) { throw "download failed" }
        Expand-Archive -Path $NuPkg -DestinationPath $NuDir -Force
        New-Item -ItemType Directory -Path $IncDir, $LibDir -Force | Out-Null
        Copy-Item (Join-Path $NuDir "tools\include\*") $IncDir -Recurse -Force
        Copy-Item (Join-Path $NuDir "tools\libs\*")    $LibDir -Recurse -Force
        Remove-Item $NuDir -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item $NuPkg -Force -ErrorAction SilentlyContinue
        Write-Host "  Python headers installed." -ForegroundColor Green
    } catch {
        Write-Host "  [WARN] Could not add Python headers - source builds will fail." -ForegroundColor Yellow
    }
}

# No triton guard here any more. It existed because xformers assigned to
# jitted_fn.src and newer triton made that read-only; xformers is no longer
# installed, and torch 2.10 declares no triton pin for the guard to read.
# triton is pinned outright beside the torch install instead.

# Florence2 requires transformers >= 4.45 for is_flash_attn_greater_or_equal_2_10,
# and less than 5. The floor was here and the ceiling was not, so an unbounded
# --upgrade answered "at least 4.45" with 5.14.1. Florence2 ships its own model
# code and its own _beam_search, written against the 4.x generation API; on 5.x
# it indexed out of range and raised a CUDA device-side assert, which poisons
# the context so every later CUDA call in the process fails as well.
#
# No custom node here declares an upper bound, and the highest floor asked for
# is 4.57.1 - so the newest 4.x satisfies all of them.
# Continue: a warning on stderr becomes a NativeCommandError under
# Stop, and this probe is judged by its exit code, not by that.
$ErrorActionPreference = "Continue"
$TransformersVersion = & $PyExe -c "import transformers; print(transformers.__version__)" 2>$null
$ProbeExit = $LASTEXITCODE
$ErrorActionPreference = "Stop"
$global:LASTEXITCODE = $ProbeExit
$NeedsTransformersUpgrade = $true
$TransformersTooNew = $false
if ($TransformersVersion -match '^(\d+)\.(\d+)') {
    $Major = [int]$Matches[1]; $Minor = [int]$Matches[2]
    # Both bounds. `$Major -gt 4` used to satisfy this on its own, so an install
    # that arrived on 5.x - a node with an unbounded transformers requirement is
    # enough - was reported "OK" and left there.
    if ($Major -ge 5) {
        $TransformersTooNew = $true
    } elseif ($Major -eq 4 -and $Minor -ge 45) {
        $NeedsTransformersUpgrade = $false
    }
}
if ($TransformersTooNew) {
    Write-Host "  transformers $TransformersVersion is above the ceiling - Florence2 needs 4.x." -ForegroundColor Yellow
    Write-Host "    (on 5.x its own _beam_search raises a CUDA assert that poisons the context)" -ForegroundColor DarkGray
}
if ($NeedsTransformersUpgrade -or $TransformersTooNew) {
    Write-Host "  Upgrading transformers (Florence2 fix)..." -ForegroundColor White
    Write-Host "    (may take a minute)" -ForegroundColor DarkGray
    Invoke-Pip -PyExe $PyExe -Label "transformers" `
        -PipArgs @("-m","pip","install","--upgrade","--upgrade-strategy","only-if-needed","transformers>=4.45,<5","--no-warn-script-location") | Out-Null
    # Continue: a warning on stderr becomes a NativeCommandError under
    # Stop, and this probe is judged by its exit code, not by that.
    $ErrorActionPreference = "Continue"
    $NowTransformers = & $PyExe -c "import transformers; print(transformers.__version__)" 2>$null
    $ProbeExit = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    $global:LASTEXITCODE = $ProbeExit
    if ($NowTransformers) {
        Write-Host "  transformers at $($NowTransformers.Trim())" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] transformers did not import after the upgrade - see logs\update_pip.log." -ForegroundColor Yellow
    }
} else {
    Write-Host "  transformers OK ($TransformersVersion)" -ForegroundColor Green
}

# llama-cpp-python for Searge LLM - prebuilt wheel (source build needs MSVC).
# Continue: a warning on stderr becomes a NativeCommandError under
# Stop, and this probe is judged by its exit code, not by that.
$ErrorActionPreference = "Continue"
& $PyExe -c "import llama_cpp" 2>$null
$ProbeExit = $LASTEXITCODE
$ErrorActionPreference = "Stop"
$global:LASTEXITCODE = $ProbeExit
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Installing llama-cpp-python (prebuilt, for Searge LLM)..." -ForegroundColor White
    & $PyExe -m pip install llama-cpp-python --prefer-binary --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu --no-warn-script-location 2>&1
    Write-Host "  llama-cpp-python installed OK" -ForegroundColor Green
} else {
    Write-Host "  llama-cpp-python OK" -ForegroundColor Green
}

# Chatterbox TTS (natural voice engine). --no-deps on purpose: its pins would
# downgrade transformers/numpy/diffusers/starlette. setuptools<81 for pkg_resources.
# Continue, and no stderr redirect. `perth` warns about pkg_resources on
# import, and PowerShell 5.1 turns a native command's redirected stderr into a
# NativeCommandError - which under Stop ends the whole update. The exit code is
# the only thing here that means anything.
$ErrorActionPreference = "Continue"
& $PyExe -c "import chatterbox, pyloudnorm" | Out-Null
$ChatterboxMissing = ($LASTEXITCODE -ne 0)
$ErrorActionPreference = "Stop"
if ($ChatterboxMissing) {
    Write-Host "  Installing Chatterbox TTS (natural voice engine)..." -ForegroundColor White
    & $PyExe -m pip install --no-deps chatterbox-tts --no-warn-script-location 2>&1
    & $PyExe -m pip install conformer s3tokenizer resemble-perth pydub pyloudnorm --no-warn-script-location 2>&1
    & $PyExe -m pip install "setuptools==80.9.0" --no-warn-script-location 2>&1
    Write-Host "  Chatterbox TTS installed OK" -ForegroundColor Green
} else {
    Write-Host "  Chatterbox TTS OK" -ForegroundColor Green
}

}

# ============================================================================
# 2. FRONTEND - npm install
# ============================================================================
if (-not $NeedFrontend) {
    Write-Host "`n[2/3] Frontend dependencies unchanged by this update" -ForegroundColor Green
} else {
Write-Host "`n[2/3] Updating frontend dependencies..." -ForegroundColor Yellow
$FrontendDir = Join-Path $RootPath "frontend"

if (Test-Path $FrontendDir) {
    Set-Location $FrontendDir

    if ($Mode -eq "portable") {
        $NodeExeDir = Join-Path $RootPath "node_embeded"
        # Ensure npm shims exist
        if (Test-Path $NodeExeDir) {
            $NpmShim = Join-Path $NodeExeDir "node_modules\npm\bin\npm.cmd"
            $NpxShim = Join-Path $NodeExeDir "node_modules\npm\bin\npx.cmd"
            if (Test-Path $NpmShim) { Copy-Item $NpmShim $NodeExeDir -Force }
            if (Test-Path $NpxShim) { Copy-Item $NpxShim $NodeExeDir -Force }
        }
        $NpmCmd = Join-Path $NodeExeDir "npm.cmd"
        if (Test-Path $NpmCmd) {
            Write-Host "    (npm install in progress - can take a few minutes)" -ForegroundColor DarkGray
            & "$NpmCmd" "install" 2>&1
            Write-Host "  Frontend dependencies updated." -ForegroundColor Green
        }
        else {
            $NodeExe = Join-Path $NodeExeDir "node.exe"
            $NpmCli = Join-Path $NodeExeDir "node_modules\npm\bin\npm-cli.js"
            if (Test-Path $NpmCli) {
                Write-Host "    (npm install in progress - can take a few minutes)" -ForegroundColor DarkGray
                & "$NodeExe" "$NpmCli" "install" 2>&1
                Write-Host "  Frontend dependencies updated." -ForegroundColor Green
            }
            else {
                Write-Host "  [WARNING] npm not found - run install.bat first" -ForegroundColor Yellow
            }
        }
    } else {
        # Lite mode - use system npm
        Write-Host "    (npm install in progress - can take a few minutes)" -ForegroundColor DarkGray
        & npm install 2>&1
        Write-Host "  Frontend dependencies updated." -ForegroundColor Green
    }

    Set-Location $RootPath
}

}

# ============================================================================
# 3. SYNC COMFYUI REQUIREMENTS
# ============================================================================

# Ensure required ComfyUI core dependencies are in sync after ComfyUI updates
Write-Host "`n[2a/3] Syncing ComfyUI requirements..." -ForegroundColor Yellow
$ComfyRequirements = Join-Path $ComfyDir "requirements.txt"
if (Test-Path $ComfyRequirements) {
    try {
        Write-Host "    (syncing ComfyUI requirements - may take a minute)" -ForegroundColor DarkGray
        & $PyExe -m pip install -r "$ComfyRequirements" --no-warn-script-location 2>&1
        Write-Host "  ComfyUI requirements synced." -ForegroundColor Green
    } catch {
        Write-Host "  [WARNING] ComfyUI requirements sync failed (non-fatal): $_" -ForegroundColor Yellow
    }
}

# Ensure backend voice fallback dependency exists after update
try {
    Write-Host "    (installing edge-tts fallback)" -ForegroundColor DarkGray
    & $PyExe -m pip install edge-tts --no-warn-script-location 2>&1
    Write-Host "  edge-tts synced." -ForegroundColor Green
} catch {
    Write-Host "  [WARNING] edge-tts sync failed (non-fatal): $_" -ForegroundColor Yellow
}

# Keep Comfy preview defaults enabled for end users.
Write-Host "`n[2b/3] Applying Comfy preview defaults..." -ForegroundColor Yellow
$PreviewSetupScript = Join-Path $RootPath "scripts\setup_comfyui_config.py"
if (Test-Path $PreviewSetupScript) {
    try {
        & $PyExe "$PreviewSetupScript" 2>&1 | Out-Null
        Write-Host "  Preview defaults applied (Execution=auto, VHS=Always)." -ForegroundColor Green
    } catch {
        Write-Host "  [WARNING] Preview defaults update failed (non-fatal): $_" -ForegroundColor Yellow
    }
} else {
    Write-Host "  [WARNING] setup_comfyui_config.py not found, skipping preview defaults." -ForegroundColor Yellow
}

# Republished every update: the set changes, and eighteen graphs were deleted
# in one commit today. A copy made once at install time slowly stops matching
# what the app can run.
Write-Host "`n[2c/3] Publishing workflows to ComfyUI..." -ForegroundColor Yellow
$PublishWorkflows = Join-Path $RootPath "scripts\publish_workflows.ps1"
if (Test-Path $PublishWorkflows) {
    & $PublishWorkflows -RootPath $RootPath
} else {
    Write-Host "  [WARNING] publish_workflows.ps1 not found, skipping." -ForegroundColor Yellow
}

# Z-Image core models are NOT auto-downloaded (even on update).
# They will be downloaded by ComfyUI when a user actually runs a Z-Image workflow.
# (Removed per requirement - no auto model downloads in installer or update)


# ============================================================================
# DONE
# ============================================================================
if (-not $FeddaTranscriptOwner) {
    if ($script:PipFailures.Count -gt 0) {
        Write-Host ""
        Write-Host "  These nodes had dependency problems:" -ForegroundColor Yellow
        foreach ($f in ($script:PipFailures | Sort-Object -Unique)) {
            Write-Host "    - $f" -ForegroundColor Yellow
        }
        Write-Host "  Full output: logs\update_pip.log" -ForegroundColor DarkGray
        Write-Host "  FEDDA still runs; the nodes above may be missing a feature." -ForegroundColor DarkGray
        Write-Host ""
    }
    try { Stop-Transcript | Out-Null } catch {}
}

if (-not $SilentMode) {
    Write-Host "`n===================================================" -ForegroundColor Green
    Write-Host "   UPDATE COMPLETE" -ForegroundColor Green
    Write-Host "===================================================" -ForegroundColor Green
    Write-Host "Run RUN.bat to start FEDDA."
}
