param([string]$RootPath = "")

# Repair a ComfyUI that will not import.
#
# The failure this exists for:
#
#     ValueError: infer_schema(func): Parameter kernel_size has unsupported
#     type list[int]
#
# comfy_kitchen registers a custom op typed with PEP 585 generics, and
# torch.library.infer_schema in torch 2.6 rejects them. ComfyUI imports
# comfy_kitchen from comfy/quant_ops.py at startup, so nothing runs at all -
# the launcher reports only that port 8199 never answered.
#
# It is the cu124 ceiling arriving: 2.6.0 is the newest torch that channel
# carries, and current ComfyUI wants newer. CLAUDE.md has the long version.
#
# Fixes it by walking back, testing after every step rather than assuming:
#
#   1. does it import already? then nothing is wrong
#   2. try the comfy-kitchen versions known to import on torch 2.6
#   3. failing that, put ComfyUI on the commit the installer pins
#
# Each step is checked with `import comfy.model_base, comfy.ldm.modules.attention`
# rather than comfy.utils. utils was the first thing tried during this
# investigation and it passed while the app was still broken: the call that
# fails lives in attention.py, and utils never reaches it.

if (-not $RootPath) { $RootPath = Split-Path $PSScriptRoot -Parent }

$Py       = Join-Path $RootPath "python_embeded\python.exe"
$ComfyDir = Join-Path $RootPath "ComfyUI"
# What install.ps1 checks out on a fresh install. Was a2840e75 (v0.18.1)
# while FEDDA sat on cu124; falling back to it now would undo a migrated
# install and take the MiniMax H3 nodes away with it.
$Pinned   = "v0.33.1"

# Known to import on torch 2.6, newest first. 0.2.26 is the version this was
# verified against; the two below it are there in case a future torch or a
# future ComfyUI moves the line again.
$KitchenCandidates = @("0.2.26", "0.2.25", "0.2.24")

Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "     FEDDA  -  repair ComfyUI startup" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $Py))       { Write-Host "  [ERROR] python_embeded not found. Run the installer first." -ForegroundColor Red; exit 1 }
if (-not (Test-Path $ComfyDir)) { Write-Host "  [ERROR] ComfyUI not found. Run the installer first." -ForegroundColor Red; exit 1 }

function Test-ComfyImports {
    $ErrorActionPreference = "Continue"
    & $Py -c "import sys; sys.path.insert(0, r'$ComfyDir'); import comfy.model_base, comfy.ldm.modules.attention" 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Show-Versions {
    $ErrorActionPreference = "Continue"
    $v = & $Py -c "import importlib.metadata as m
for p in ('torch','comfy-kitchen'):
    try: print('    %-16s %s' % (p, m.version(p)))
    except Exception: print('    %-16s -' % p)" 2>$null
    $v | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
    try {
        $head = (& git -C $ComfyDir describe --tags 2>$null)
        if ($head) { Write-Host ("    {0,-16} {1}" -f "ComfyUI", $head.Trim()) -ForegroundColor DarkGray }
    } catch { }
}

Write-Host "  Currently installed:" -ForegroundColor White
Show-Versions
Write-Host ""

Write-Host "  Checking whether ComfyUI imports..." -NoNewline -ForegroundColor Yellow
if (Test-ComfyImports) {
    Write-Host " it does." -ForegroundColor Green
    Write-Host "  Nothing to repair. If FEDDA still will not start, the reason is" -ForegroundColor DarkGray
    Write-Host "  at the end of logs\comfyui_live.err.log and is something else." -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}
Write-Host " no." -ForegroundColor Red
Write-Host ""

# ── 2. comfy-kitchen ───────────────────────────────────────────────────────
foreach ($v in $KitchenCandidates) {
    Write-Host "  Trying comfy-kitchen $v ..." -NoNewline -ForegroundColor Yellow
    $ErrorActionPreference = "Continue"
    & $Py -m pip install "comfy-kitchen==$v" --no-input --no-warn-script-location 2>&1 | Out-Null
    if (Test-ComfyImports) {
        Write-Host " ComfyUI imports." -ForegroundColor Green
        Write-Host ""
        Write-Host "  Fixed. fp8 and fp4 are unavailable at this version - that is the" -ForegroundColor Yellow
        Write-Host "  trade for running on this PyTorch, and everything else works." -ForegroundColor DarkGray
        Write-Host ""
        Show-Versions
        exit 0
    }
    Write-Host " still failing." -ForegroundColor DarkGray
}

# ── 3. ComfyUI itself ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "  No comfy-kitchen version worked. Putting ComfyUI back on the commit" -ForegroundColor Yellow
Write-Host "  the installer pins ($Pinned)..." -ForegroundColor Yellow
$ErrorActionPreference = "Continue"
& git -C $ComfyDir fetch --tags origin 2>&1 | Out-Null
& git -C $ComfyDir checkout $Pinned 2>&1 | Out-Null

if (Test-ComfyImports) {
    Write-Host "  ComfyUI imports." -ForegroundColor Green

    # comfy-kitchen is wherever the last attempt above left it, which has
    # nothing to do with what this ComfyUI wants. Put it back to what the
    # version now checked out pins, and only if that still imports - the
    # working state is worth more than a tidy version number.
    $Req = Join-Path $ComfyDir "requirements.txt"
    if (Test-Path $Req) {
        $Pin = Select-String -Path $Req -Pattern '^comfy-kitchen==' -ErrorAction SilentlyContinue |
               Select-Object -First 1
        if ($Pin) {
            $Want = $Pin.Line.Trim()
            Write-Host "  Restoring $Want for this ComfyUI..." -NoNewline -ForegroundColor Yellow
            $Before = (& $Py -c "import importlib.metadata as m; print(m.version('comfy-kitchen'))" 2>$null)
            $ErrorActionPreference = "Continue"
            & $Py -m pip install $Want --no-input --no-warn-script-location 2>&1 | Out-Null
            if (Test-ComfyImports) {
                Write-Host " done." -ForegroundColor Green
            } else {
                Write-Host " it stopped importing - putting the working one back." -ForegroundColor Yellow
                if ($Before) {
                    & $Py -m pip install ("comfy-kitchen==" + $Before.Trim()) --no-input --no-warn-script-location 2>&1 | Out-Null
                }
            }
        }
    }

    Write-Host ""
    Write-Host "  It is now on the version a fresh install uses. Newer ComfyUI needs a" -ForegroundColor DarkGray
    Write-Host "  newer PyTorch than the cu124 wheels provide - see CLAUDE.md." -ForegroundColor DarkGray
    Write-Host ""
    Show-Versions
    exit 0
}

Write-Host ""
Write-Host "  [WARN] Still failing after both. The last lines of" -ForegroundColor Red
Write-Host "         logs\comfyui_live.err.log are what to send on." -ForegroundColor Red
Write-Host ""
Show-Versions
exit 1
