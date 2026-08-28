# ============================================================================
# FEDDAKALKUN Main Installer - Hybrid (Embedded Python + System Git/Node)
# ============================================================================
# Assumes: Git, Node.js 18+, npm (Python is embedded automatically)
# Creates: embedded Python runtime + ComfyUI + custom nodes + frontend + backend
# ============================================================================

param(
    [switch]$Unattended
)

if ($env:FEDDA_UNATTENDED -eq "1") {
    $Unattended = $true
}

# Keep git non-interactive so a bad/gated node URL can't hang the install on an
# auth prompt, pager, or editor.
$env:GIT_PAGER = 'cat'
$env:GIT_EDITOR = 'true'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'

$ErrorActionPreference = "Stop"
$ScriptPath = $PSScriptRoot
$RootPath = Split-Path -Parent $ScriptPath
$RootPath = (Resolve-Path $RootPath).Path
Set-Location $RootPath

# Logging
$LogsDir = Join-Path $RootPath "logs"
if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir | Out-Null }
$LogFile = Join-Path $LogsDir "install_fast_log.txt"

function Write-Step {
    param([string]$Message, [string]$Color = "White")
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "  [$ts] $Message" -ForegroundColor $Color
    Add-Content -Path $LogFile -Value "[$ts] $Message" -ErrorAction SilentlyContinue
}

function Write-Header {
    param([string]$Title)
    Write-Host ""
    Write-Host "  =================================================" -ForegroundColor DarkGray
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host "  =================================================" -ForegroundColor DarkGray
}

function Test-Command {
    param([string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-OllamaRunning {
    $urls = @(
        "http://127.0.0.1:11434/api/tags",
        "http://localhost:11434/api/tags"
    )

    foreach ($url in $urls) {
        try {
            $resp = Invoke-WebRequest -Uri $url -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
            if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) {
                return $true
            }
        } catch {
            # Try the next hostname. Some Windows setups bind only IPv4 or localhost.
        }
    }

    return $false
}
function Install-EmbeddedOllama {
    param([string]$RootPath, [string]$LogFile)
    
    $OllamaDir = Join-Path $RootPath "ollama_embeded"
    $OllamaExe = Join-Path $OllamaDir "ollama.exe"
    
    if (Test-Path $OllamaExe) {
        Write-Step "Embedded Ollama already installed." "Green"
        return $true
    }
    
    Write-Header "INSTALLING EMBEDDED OLLAMA"
    Write-Step "Downloading Ollama portable binary (v0.5.4)..." "Yellow"
    
    New-Item -ItemType Directory -Path $OllamaDir -Force | Out-Null
    $OllamaZip = Join-Path $OllamaDir "ollama.zip"
    
    try {
        # Download Ollama
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri "https://github.com/ollama/ollama/releases/download/v0.5.4/ollama-windows-amd64.zip" -OutFile $OllamaZip -UseBasicParsing
        
        Write-Step "Extracting Ollama..." "Yellow"
        Expand-Archive -Path $OllamaZip -DestinationPath $OllamaDir -Force
        Remove-Item $OllamaZip -Force
        
        Write-Step "Embedded Ollama installed successfully!" "Green"
        Write-Host "  Run 'ollama serve' to start Ollama." -ForegroundColor Gray
        return $true
    }
    catch {
        Write-Step "Failed to download Ollama: $_" "Red"
        return $false
    }
}

function Download-ZImageTurboCelebPack {
    param(
        [string]$PythonExe,
        [string]$ComfyDir
    )

    Write-Header "STEP 4.5/7 - Z-Image Turbo Celeb LoRA Pack"
    $TargetDir = Join-Path $ComfyDir "models\loras\zimage_turbo"
    if (-not (Test-Path $TargetDir)) {
        New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    }

    $PyScript = Join-Path $env:TEMP "feddaz_zimage_turbo_sync_lite.py"
    $PyCode = @"
import json
import os
import subprocess
import sys
import urllib.request

repo = "pmczip/Z-Image-Turbo_Models"
target = r"$TargetDir"
api = f"https://huggingface.co/api/models/{repo}/tree/main"

os.makedirs(target, exist_ok=True)

with urllib.request.urlopen(api, timeout=60) as resp:
    items = json.loads(resp.read().decode("utf-8", errors="ignore"))

files = []
for item in items:
    p = str(item.get("path", "")).strip()
    if p.lower().endswith(".safetensors") and "/" not in p:
        files.append(p)

files = sorted(set(files))
print(f"[Z-Image Turbo] Found {len(files)} LoRA files")

downloaded = 0
skipped = 0
failed = 0

for i, name in enumerate(files, start=1):
    out = os.path.join(target, name)
    if os.path.exists(out) and os.path.getsize(out) > 10000:
        skipped += 1
        print(f"[{i}/{len(files)}] Skip existing: {name}")
        continue

    url = f"https://huggingface.co/{repo}/resolve/main/{name}"
    print(f"[{i}/{len(files)}] Download: {name}")
    cmd = ["curl.exe", "-L", "--retry", "3", "--retry-delay", "2", "-o", out, url]
    result = subprocess.run(cmd)
    if result.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 10000:
        downloaded += 1
    else:
        failed += 1
        try:
            if os.path.exists(out) and os.path.getsize(out) < 10000:
                os.remove(out)
        except Exception:
            pass

print(f"[Z-Image Turbo] Done. Downloaded={downloaded}, Skipped={skipped}, Failed={failed}")
sys.exit(0 if failed == 0 else 2)
"@
    Set-Content -Path $PyScript -Value $PyCode -Encoding UTF8

    try {
        & $PythonExe $PyScript
        if ($LASTEXITCODE -eq 0) {
            Write-Step "Z-Image Turbo celeb pack installed." "Green"
        } else {
            Write-Step "Z-Image Turbo download completed with partial failures (code $LASTEXITCODE)." "Yellow"
        }
    } catch {
        Write-Step "Z-Image Turbo download failed: $_" "Yellow"
    } finally {
        if (Test-Path $PyScript) {
            Remove-Item $PyScript -Force -ErrorAction SilentlyContinue
        }
    }
}


if (-not $Unattended) {
    Clear-Host
}

Write-Host ""
Write-Host "  ========================================================" -ForegroundColor Cyan
Write-Host "                                                          " -ForegroundColor Cyan
Write-Host "         FEDDAKALKUN MAIN INSTALLER" -ForegroundColor Cyan
Write-Host "         Uses embedded Python + system Git/Node" -ForegroundColor Cyan
Write-Host "                                                          " -ForegroundColor Cyan
Write-Host "  ========================================================" -ForegroundColor Cyan
Write-Host ""

if ($Unattended) {
    Write-Host "  Unattended install - progress below, no input required." -ForegroundColor Gray
    Write-Host ""
}

# --- Detect System Tools ---
Write-Header "SYSTEM CHECK"

$AllGood = $true

# Python - informational only, we always embed Python 3.11.9 regardless of system version
if (Test-Command "python") {
    $PyVersion = & python --version 2>&1
    Write-Step "Python:  $PyVersion (system - will use embedded 3.11.9 instead)" "Gray"
} else {
    Write-Step "Python:  not installed on system (embedded 3.11.9 will be downloaded)" "Gray"
}
# No $AllGood = $false here - system Python is never required in Lite anymore

# Git
if (Test-Command "git") {
    $GitVersion = & git --version 2>&1
    Write-Step "Git:     $GitVersion" "Green"
} else {
    Write-Step "Git:     NOT FOUND - install from git-scm.com" "Red"
    $AllGood = $false
}

# Node.js - check presence AND minimum version (18+ required for Vite 7 / React 19)
$NODE_MIN = 18
if (Test-Command "node") {
    $NodeVersion = & node --version 2>&1    # e.g. "v20.11.0"
    if ($NodeVersion -match "v(\d+)\.") {
        $NodeMajor = [int]$Matches[1]
        if ($NodeMajor -lt $NODE_MIN) {
            Write-Step "Node.js: $NodeVersion  <<  INCOMPATIBLE (need v18+)" "Red"
            Write-Host ""
            Write-Host "  [!] NODE.JS TOO OLD" -ForegroundColor Red
            Write-Host "      Your version: $NodeVersion" -ForegroundColor Red
            Write-Host "      Required: v18 or newer (for Vite 7 + React 19)" -ForegroundColor Yellow
            Write-Host "      Download: https://nodejs.org  (choose LTS)" -ForegroundColor Cyan
            Write-Host ""
            $AllGood = $false
        } else {
            Write-Step "Node.js: $NodeVersion" "Green"
        }
    } else {
        Write-Step "Node.js: $NodeVersion" "Green"
    }
} else {
    Write-Step "Node.js: NOT FOUND - install from nodejs.org" "Red"
    $AllGood = $false
}

# npm
if (Test-Command "npm") {
    $NpmVersion = & npm --version 2>&1
    Write-Step "npm:     v$NpmVersion" "Green"
} else {
    Write-Step "npm:     NOT FOUND" "Red"
    $AllGood = $false
}

# Ollama - check if installed and reachable on the local API port.
$OllamaInstalled = Test-Command "ollama"
$OllamaRunning = Test-OllamaRunning

if ($OllamaInstalled -and $OllamaRunning) {
    $OllamaVersion = & ollama --version 2>&1
    Write-Step "Ollama:  $OllamaVersion (running)" "Green"
} elseif ($OllamaInstalled) {
    Write-Step "Ollama:  Installed but local API is not reachable on port 11434" "Yellow"
} elseif ($OllamaRunning) {
    Write-Step "Ollama:  Running on port 11434 (command not on PATH)" "Green"
} else {
    Write-Step "Ollama:  NOT INSTALLED/RUNNING (optional - Ollama Models page offline)" "Yellow"
}

# NVIDIA GPU
try {
    $NvidiaGPU = Get-CimInstance Win32_VideoController -ErrorAction Stop | Where-Object { $_.Name -match "NVIDIA" } | Select-Object -First 1
    if ($NvidiaGPU) {
        $VRAM_MB = 0
        try {
            $SmiOut = & nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null
            if ($SmiOut) { $VRAM_MB = [int]($SmiOut.Trim()) }
        } catch {}
        $VRAMStr = ""
        if ($VRAM_MB -gt 0) { $VRAMStr = " ($([math]::Round($VRAM_MB / 1024)) GB VRAM)" }
        Write-Step "GPU:     $($NvidiaGPU.Name)$VRAMStr" "Green"
    } else {
        Write-Step "GPU:     No NVIDIA GPU found - CUDA required!" "Red"
        $AllGood = $false
    }
} catch {
    Write-Step "GPU:     Detection failed" "Yellow"
}

# RAM & Disk
$OSInfo = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$RAM_GB = 0
if ($OSInfo) { $RAM_GB = [math]::Round($OSInfo.TotalVisibleMemorySize / 1MB) }
$Drive = (Get-Item $RootPath).PSDrive
$FreeGB = [math]::Round($Drive.Free / 1GB)

$RAMColor = "Yellow"
if ($RAM_GB -ge 16) { $RAMColor = "Green" }
Write-Step "RAM:     ${RAM_GB} GB" $RAMColor

$DiskColor = "Red"
if ($FreeGB -ge 10) { $DiskColor = "Green" }
elseif ($FreeGB -ge 5) { $DiskColor = "Yellow" }
Write-Step "Disk:    ${FreeGB} GB free on $($Drive.Name):\" $DiskColor

Write-Host ""

if (-not $AllGood) {
    Write-Host "  MISSING REQUIREMENTS - install the tools marked in red above." -ForegroundColor Red
    Write-Host ""
    if (-not $Unattended) {
        Read-Host "  Press Enter to exit"
    }
    exit 1
}

# Ollama Check (Warning if not running)
if (-not $OllamaRunning) {
    if ($Unattended) {
        Write-Step "Ollama not running - continuing without it (optional component)." "Yellow"
    } else {
        Write-Host ""
        Write-Host "  [!] OLLAMA NOT RUNNING" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  Ollama is used by the Ollama Models page and local model helpers. Without it:" -ForegroundColor Yellow
        Write-Host "    - Ollama model management will show offline" -ForegroundColor Gray
        Write-Host "    - Image and video workflows will still install normally" -ForegroundColor Gray
        Write-Host ""
        Write-Host "  Options:" -ForegroundColor White
        if ($OllamaInstalled) {
            Write-Host "    1) Continue install (Ollama will be used when you start it)" -ForegroundColor Gray
            Write-Host "    2) Cancel and start Ollama first (recommended)" -ForegroundColor Gray
            Write-Host "    3) Download & install embedded Ollama (portable, no system install needed)" -ForegroundColor Gray
        } else {
            Write-Host "    1) Continue install (skip Ollama for now)" -ForegroundColor Gray
            Write-Host "    2) Cancel and download Ollama from https://ollama.ai" -ForegroundColor Gray
            Write-Host "    3) Download & install embedded Ollama (portable, included)" -ForegroundColor Gray
        }
        Write-Host ""
        $OllamaChoice = Read-Host "  Enter 1, 2, or 3 (default: 1)"
        
        if ($OllamaChoice -eq "2") {
            Write-Host ""
            if ($OllamaInstalled) {
                Write-Host "  Start Ollama with: ollama serve" -ForegroundColor Cyan
                Write-Host "  Then run this installer again." -ForegroundColor White
            } else {
                Write-Host "  Download from https://ollama.ai" -ForegroundColor Cyan
                Write-Host "  Then run this installer again." -ForegroundColor White
            }
            Write-Host ""
            Read-Host "  Press Enter to exit"
            exit 0
        }
        elseif ($OllamaChoice -eq "3") {
            $EmbeddedSuccess = Install-EmbeddedOllama -RootPath $RootPath -LogFile $LogFile
            if (-not $EmbeddedSuccess) {
                Write-Host ""
                Write-Host "  Failed to download embedded Ollama. Check your internet connection." -ForegroundColor Red
                Write-Host "  You can still continue without it." -ForegroundColor Yellow
            } else {
                Write-Host "  Embedded Ollama is ready. It will start with run.bat." -ForegroundColor Green
                $OllamaRunning = $true
            }
        }
        
        if (-not $OllamaRunning) {
            Write-Host "  Continuing install without Ollama..." -ForegroundColor Yellow
        }
    }
}

# Confirm
Write-Host "  All system tools detected. Root: $RootPath" -ForegroundColor Gray
Write-Host ""
if ($Unattended) {
    Write-Step "Starting main install automatically..." "Cyan"
} else {
    $Confirm = Read-Host "  Press ENTER to install, or N to cancel"
    if ($Confirm -eq "N" -or $Confirm -eq "n") { exit 0 }
}

$StopWatch = [System.Diagnostics.Stopwatch]::StartNew()

# ============================================================================
# 0. EMBED PYTHON 3.11.9 (always - eliminates version compatibility issues)
# Main install uses system Git + Node; Python is always our known-good embedded version
# ============================================================================
Write-Header "STEP 0/7 - Embedded Python 3.11.9 (guaranteed compatible)"

$PyEmbedDir = Join-Path $RootPath "python_embeded"
$PyEmbedExe = Join-Path $PyEmbedDir "python.exe"

if (-not (Test-Path $PyEmbedExe)) {
    Write-Step "Downloading Python 3.11.9 portable (~8 MB)..." "Yellow"
    $PyZip = Join-Path $RootPath "python_embed.zip"
    try {
        & curl.exe -L -o "$PyZip" "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip" --progress-bar --retry 3 --retry-delay 2
        if ($LASTEXITCODE -ne 0) { throw "Download failed" }

        Write-Step "Extracting Python 3.11.9..." "Yellow"
        New-Item -ItemType Directory -Path $PyEmbedDir -Force | Out-Null
        Expand-Archive -Path $PyZip -DestinationPath $PyEmbedDir -Force
        Remove-Item $PyZip -Force

        # Enable site-packages and add ComfyUI to path
        $PthFile = Join-Path $PyEmbedDir "python311._pth"
        if (Test-Path $PthFile) {
            $Content = Get-Content $PthFile
            $Content = $Content -replace "#import site", "import site"
            if ($Content -notcontains "../ComfyUI") { $Content += "../ComfyUI" }
            Set-Content -Path $PthFile -Value $Content
        }

        # The embeddable distribution ships no C headers and no import
        # library. Anything that has to be compiled - a package with no wheel
        # for cp311/win_amd64 - then fails on "Cannot open include file:
        # 'Python.h'", which reads like a broken toolchain and is not: the
        # toolchain is fine, the interpreter is missing half of itself.
        # Surfaced by stringzilla during a node update, but it was every
        # source build. The nuget build of the same version carries both.
        $IncDir = Join-Path $PyEmbedDir "Include"
        $LibDir = Join-Path $PyEmbedDir "libs"
        if (-not (Test-Path (Join-Path $IncDir "Python.h"))) {
            Write-Step "Adding Python headers (so packages with no wheel can build)..." "Yellow"
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
                Write-Step "Python headers installed." "Green"
            } catch {
                Write-Step "Could not add Python headers - packages with no wheel will fail to build." "Yellow"
            }
        }

        # Install pip into embedded Python
        Write-Step "Installing pip into embedded Python..." "Yellow"
        $GetPip = Join-Path $RootPath "get-pip.py"
        & curl.exe -L -o "$GetPip" "https://bootstrap.pypa.io/get-pip.py" --retry 3 --retry-delay 2
        & $PyEmbedExe $GetPip
        Remove-Item $GetPip -Force

        Write-Step "Python 3.11.9 embedded and configured." "Green"
    } catch {
        Write-Step "ERROR: Could not download embedded Python. FEDDA needs a local Python runtime." "Red"
        Write-Step "Check internet access, antivirus quarantine, or manually re-run scripts\install.bat." "Yellow"
        if (Test-Path $PyEmbedDir) { Remove-Item $PyEmbedDir -Recurse -Force -ErrorAction SilentlyContinue }
        throw "Embedded Python download failed"
    }
} else {
    Write-Step "Embedded Python 3.11.9 already present." "Green"
}

# Determine the Python to use for ALL steps - embedded zip has NO venv module,
# so we install packages directly into embedded Python (same as portable installer).
$EmbedPy = $PyEmbedExe
if (-not (Test-Path $EmbedPy)) {
    Write-Step "ERROR: Embedded Python is missing after install step." "Red"
    throw "Embedded Python not found"
} else {
    Write-Step "Using embedded Python 3.11.9 directly (no venv - embedded zip lacks venv module)." "Green"
}

# ============================================================================
# 0.5 SSL CERTIFICATE REPAIR (critical for CivitAI, HF, model downloads)
# ============================================================================
$FixSslScript = Join-Path $ScriptPath "fix_embedded_ssl.ps1"
if (Test-Path $FixSslScript) {
    Write-Step "Running embedded Python SSL certificate repair..." "Cyan"
    & powershell -ExecutionPolicy Bypass -File $FixSslScript -RootPath $RootPath -PythonExe $EmbedPy
} else {
    Write-Step "SSL fix script not found (skipping)..." "Yellow"
}

# ============================================================================
# 1. PYTHON PACKAGES (directly into embedded Python - no venv)
# ============================================================================
Write-Header "STEP 1/7 - Python Setup"

# Alias $VenvPy so the rest of the script stays unchanged
$VenvPy  = $EmbedPy
$VenvPip = Join-Path (Split-Path $EmbedPy) "Scripts\pip.exe"

Write-Step "pip is ready in embedded Python." "Green"

# ---------------------------------------------------------------------------
# Astral uv - a resolver written in Rust. Optional on purpose: if the download
# fails, every install below still runs through pip exactly as before. Speed is
# worth having; it is not worth an installer that cannot finish without it.
# ---------------------------------------------------------------------------
$UvBin = Join-Path $RootPath "uv.exe"
if (-not (Test-Path $UvBin)) {
    try {
        Write-Step "Fetching uv (fast package resolver)..." "Yellow"
        $UvZip = Join-Path $RootPath "uv.zip"
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip" -OutFile $UvZip
        Expand-Archive -Path $UvZip -DestinationPath $RootPath -Force
        Remove-Item $UvZip -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Step "uv unavailable, using pip: $($_.Exception.Message)" "Yellow"
    }
}
if (Test-Path $UvBin) {
    Write-Step "uv ready - package installs will use it." "Green"
    # uv keeps its cache under %LOCALAPPDATA% on C:, and FEDDA is usually
    # installed on a second drive. Hardlinks cannot cross a filesystem, so uv
    # falls back to copying and warns about it - on every single call, which is
    # a dozen paragraphs of yellow across one install for something that is
    # working as intended. Saying so up front is uv's own suggested answer.
    # The cost is real and small: copying files that are already on disk, next
    # to a download measured in gigabytes.
    $env:UV_LINK_MODE = "copy"
} else {
    $UvBin = $null
}

# Helper to run pip - through uv when it is present, pip otherwise.
#
# uv is not argument-compatible with pip, and two flags used here are rejected
# outright rather than ignored: `--no-warn-script-location`, which this helper
# appends to EVERY call, and `--prefer-binary`, which insightface and
# llama-cpp-python rely on. Handing uv the pip arguments unchanged fails all
# twelve call sites with "unexpected argument". Both are safe to drop for uv:
# the first only silences a pip warning, and uv already prefers wheels.
#
# Any uv failure falls back to pip for that command, so a resolver difference
# costs time rather than the install.
function Venv-Pip {
    param([string]$PipArgs)

    if ($UvBin) {
        $UvArgs = $PipArgs -replace '\s--prefer-binary\b', ''
        $cmd = "& '$UvBin' pip $UvArgs --python '$VenvPy'"
        Invoke-Expression $cmd
        if ($LASTEXITCODE -eq 0) { return }
        Write-Step "uv could not do it, retrying with pip: $PipArgs" "Yellow"
    }

    $cmd = "& '$VenvPy' -m pip $PipArgs --no-warn-script-location"
    Invoke-Expression $cmd
    if ($LASTEXITCODE -ne 0) {
        Write-Step "WARNING: pip command had issues: $PipArgs" "Yellow"
    }
}

# ============================================================================
# 2. COMFYUI
# ============================================================================
Write-Header "STEP 2/7 - ComfyUI Core"

# v0.33.1, the version verified against torch 2.10 with this node set. The old
# pin, a2840e75, was v0.18.1 from April - far enough back that six registered
# MiniMax workflows referenced core nodes that did not exist yet.
$ComfyUICommit = "v0.33.1"
$ComfyDir = Join-Path $RootPath "ComfyUI"

if (-not (Test-Path $ComfyDir)) {
    Write-Step "Cloning ComfyUI (this can take several minutes)..." "Yellow"
    $ErrorActionPreference = "Continue"
    & git clone https://github.com/comfyanonymous/ComfyUI.git "$ComfyDir"
    $ErrorActionPreference = "Stop"
    Set-Location $ComfyDir
    $ErrorActionPreference = "Continue"
    & git checkout $ComfyUICommit 2>&1 | Out-Null
    $ErrorActionPreference = "Stop"
    Set-Location $RootPath
    Write-Step "ComfyUI cloned + pinned to $ComfyUICommit" "Green"
} else {
    Write-Step "ComfyUI already exists." "Green"
}

# ============================================================================
# 3. PYTORCH + CORE DEPS
# ============================================================================
Write-Header "STEP 3/7 - PyTorch + Dependencies"

# One channel for every card. cu130 carries Blackwell kernels, so the 50-series
# no longer needs a branch of its own, and cu124 - which receives no torch newer
# than 2.6 - is left behind deliberately.
#
# 2.6 was the ceiling that kept ComfyUI at v0.18.1, and v0.18.1 has no MiniMax H3
# nodes, no QuadrupleCLIPLoader and none of the Ideogram core nodes. Six MiniMax
# workflows were registered here and could never have run.
#
# Pinned rather than latest: 2.10.0 + v0.33.1 is the pair verified on a 3090 with
# this exact node set. cu130 also offers 2.11 through 2.13; none of them have been
# tried here.
$CudaChannel = "cu130"
$TorchVersion = "2.10.0"

Write-Step "Installing PyTorch $TorchVersion ($CudaChannel)... this takes a few minutes"
Venv-Pip ("install torch==$TorchVersion+$CudaChannel torchvision==0.25.0+$CudaChannel " +
          "torchaudio==$TorchVersion+$CudaChannel --index-url https://download.pytorch.org/whl/$CudaChannel")

# No xformers. ComfyUI defaults to pytorch attention, the reference install that
# proved this configuration has never had it, and it was the only reason triton
# needed pinning. Installing it here is what made a triton upgrade able to stop
# ComfyUI from starting at all.
Write-Step "Pinning triton to the version this torch was built beside..."
Venv-Pip "install triton-windows==3.6.0.post26"

Write-Step "Installing ComfyUI requirements..."
$ComfyReq = Join-Path $ComfyDir "requirements.txt"
Venv-Pip "install -r `"$ComfyReq`""

Write-Step "Installing build tools..."
Venv-Pip "install cmake ninja Cython"

Write-Step "Installing insightface..."
Venv-Pip "install insightface --prefer-binary --no-build-isolation"

# llama-cpp-python from a prebuilt wheel (Searge LLM needs it). Source build
# requires MSVC + scikit-build-core; the abetlen CPU wheel index has ready
# wheels for every platform/GPU, so we install it here BEFORE custom nodes -
# Searge's own requirements.txt then sees it satisfied and skips the build.
Write-Step "Installing llama-cpp-python (prebuilt wheel, for Searge LLM)..."
Venv-Pip "install llama-cpp-python --prefer-binary --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu"

# Chatterbox TTS (natural voice + cloning). --no-deps is deliberate: its pins
# (transformers 5.2, numpy 1.26, old diffusers, starlette) would downgrade the
# working ComfyUI/backend stack. The few genuinely missing deps are installed
# separately. setuptools must stay <81 - perth needs pkg_resources.
Write-Step "Installing Chatterbox TTS (natural voice engine)..."
Venv-Pip "install --no-deps chatterbox-tts"
Venv-Pip "install conformer s3tokenizer resemble-perth pydub pyloudnorm"
Venv-Pip "install setuptools==80.9.0"

# Comprehensive deps (same as portable)
Write-Step "Installing comprehensive dependencies..."
$Deps = @(
    "accelerate", "transformers", "diffusers", "safetensors",
    "huggingface-hub", "onnxruntime-gpu", "onnxruntime", "omegaconf",
    "aiohttp", "aiohttp-sse",
    # Every Edge voice in the lipsync and LTX audio pages comes from this. It
    # was missing, so /api/tts/edge-voices answered "No module named edge_tts"
    # with an empty list and the picker showed only "Default voice" - a dead
    # dropdown that looked like a UI bug rather than an absent dependency.
    "edge-tts",
    "pytube", "yt-dlp", "moviepy", "youtube-transcript-api",
    "numba",
    "imageio", "imageio-ffmpeg", "av",
    "gdown", "pandas", "reportlab",
    "GPUtil", "wandb",
    "piexif", "rembg", "pillow-heif",
    "librosa", "soundfile",
    "beautifulsoup4", "lxml", "shapely",
    "deepdiff", "matplotlib", "scipy", "scikit-image", "scikit-learn",
    "timm", "colour-science", "blend-modes", "loguru",
    "ultralytics", "opencv-python-headless", "dill",
    # The backend's own stack. `requests` is imported directly by
    # server.py, model_downloader.py and lora_service.py; it used to arrive
    # only as a dependency of huggingface-hub and yt-dlp, which works right
    # up until one of them drops it.
    "fastapi", "uvicorn[standard]", "python-multipart", "requests",
    "browser-cookie3"
)
Venv-Pip "install $($Deps -join ' ')"
# The batch above is one pip command: if ANY package fails to build/resolve on a
# fresh box, pip aborts and later packages (scipy, etc.) silently don't install -
# and ComfyUI's pinned commit hard-imports scipy at startup, so it won't boot.
# Fall back to per-package installs so one bad package can't take down the rest.
if ($LASTEXITCODE -ne 0) {
    Write-Step "Batch dep install failed - retrying each package individually so critical ones still land..." "Yellow"
    foreach ($pkg in $Deps) { Venv-Pip "install $pkg" }
}

# SageAttention needs sm_80 or better, which is 30-series and up. The published
# wheel is built for cu130 and torch 2.10 or higher, so it matches what is
# installed above; `pip install sageattention` would build from source and fail
# on a machine with no compiler.
try {
    $GPUName = (Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match "NVIDIA" } | Select-Object -First 1).Name
    if ($GPUName -match "RTX (30|40|50)\d\d") {
        Write-Step "Installing SageAttention (replaces xformers)..."
        $SageWheel = "https://github.com/woct0rdho/SageAttention/releases/download/v2.2.0-windows.post5/" +
                     "sageattention-2.2.0%2Bcu130torch2.10.0andhigher.post5-cp310-abi3-win_amd64.whl"
        Venv-Pip "install `"$SageWheel`""
    }
} catch {}

Write-Step "All Python dependencies installed." "Green"

# ============================================================================
# 4. CUSTOM NODES (pinned, from config/nodes.json)
# ============================================================================
Write-Header "STEP 4/7 - Custom Nodes"

# config/nodes.json is not written by hand - scripts/require_nodes.py derives it
# from the workflows this install actually ships, so a pack is here because
# something reaches it and for no other reason. Each one carries a commit taken
# from an install known to work, and sync_nodes.ps1 puts the folder on exactly
# that commit whether this is a first install or an update.
#
# That second part is the one v3 could not do. Its node step skipped any folder
# that already existed, so a pack installed once stayed as it was forever, and
# a fix upstream reached nobody who had already run the installer.
$SyncNodes = Join-Path $RootPath "scripts\sync_nodes.ps1"
& powershell -NoProfile -ExecutionPolicy Bypass -File $SyncNodes `
    -ComfyDir $ComfyDir -VenvPython $VenvPy
if ($LASTEXITCODE -ne 0) {
    # Not fatal. A failed pack means the workflows using it will not open, and
    # the report names it - but ComfyUI, torch and the app are already in
    # place, and stopping here would throw all of that away over one clone.
    Write-Step "One or more node packs failed - see the report" "Yellow"
}

# ============================================================================
# 5. FRONTEND
# ============================================================================
Write-Header "STEP 5/7 - Frontend (React + Vite)"

$FrontendDir = Join-Path $RootPath "frontend"
if (Test-Path $FrontendDir) {
    Set-Location $FrontendDir
    if (-not (Test-Path "node_modules")) {
        Write-Step "Running npm install (this can take 1-2 minutes)..." "Yellow"
        # To the log, like every other step. --no-fund and --no-audit drop the
        # two blocks that alarmed a tester: every advisory npm reports here is
        # in the build toolchain - vite, rollup, postcss, babel - which runs on
        # this machine over this project's own source and is absent from the
        # built app. `npm audit` still answers if anyone wants the detail, and
        # `npm audit fix` is worth avoiding: it moves vite across a major
        # version to patch something that was never exposed.
        #
        # ErrorActionPreference is relaxed for the call because npm writes
        # progress to stderr, and redirecting that under Stop turns ordinary
        # output into a terminating NativeCommandError.
        $NpmLog = Join-Path $LogsDir "npm_install.log"
        if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null }
        $PrevEap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        # npm.cmd by name, not "npm". PowerShell resolves a bare npm to
        # npm.ps1 - ExternalScript outranks Application - and a tester on
        # npm 11.5.1 got "Unknown command: pm" from that shim, an argument
        # arriving with its first character gone. The .cmd shim is what cmd
        # itself would run and takes its arguments verbatim.
        $NpmExe = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
        if (-not $NpmExe) { $NpmExe = "npm" }
        & $NpmExe install --no-fund --no-audit 2>&1 | Out-File -FilePath $NpmLog -Encoding utf8
        $NpmCode = $LASTEXITCODE
        $ErrorActionPreference = $PrevEap
        if ($NpmCode -eq 0) {
            Write-Step "Frontend dependencies installed." "Green"
        } else {
            Write-Step "npm install failed (exit $NpmCode) - see logs\npm_install.log" "Red"
        }
    } else {
        Write-Step "node_modules already exists." "Green"
    }
    Set-Location $RootPath
} else {
    Write-Step "frontend/ directory not found!" "Red"
}

# ============================================================================
# 6. ASSETS + CONFIG
# ============================================================================
Write-Header "STEP 6/7 - Assets & Configuration"

# styles.csv
$StylesSrc = Join-Path $RootPath "assets\styles.csv"
if (Test-Path $StylesSrc) {
    Copy-Item -Path $StylesSrc -Destination $ComfyDir -Force
    Write-Step "styles.csv installed." "Green"
}

# Bundled LoRAs
$SrcLoras = Join-Path $RootPath "assets\loras\z-image"
$DstLoras = Join-Path $ComfyDir "models\loras\z-image"
if (Test-Path $SrcLoras) {
    if (-not (Test-Path $DstLoras)) { New-Item -ItemType Directory -Path $DstLoras -Force | Out-Null }
    Copy-Item -Path "$SrcLoras\*" -Destination $DstLoras -Recurse -Force
    Write-Step "Bundled LoRAs (Emmy, Zana) installed." "Green"
} else {
    Write-Step "No bundled LoRAs found (download_loras.bat later)." "Yellow"
}



# ComfyUI-Manager config (weak security for auto-install)
$MgrDir = Join-Path $ComfyDir "user\__manager"
if (-not (Test-Path $MgrDir)) { New-Item -ItemType Directory -Path $MgrDir -Force | Out-Null }
$MgrConfig = @"
[default]
preview_method = auto
git_exe =
use_uv = False
channel_url = https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main
share_option = all
bypass_ssl = False
file_logging = True
component_policy = mine
update_policy = stable-comfyui
model_download_by_agent = False
downgrade_blacklist =
security_level = weak
always_lazy_install = False
network_mode = public
db_mode = remote
"@
Set-Content -Path (Join-Path $MgrDir "config.ini") -Value $MgrConfig
Write-Step "ComfyUI-Manager configured (weak security)." "Green"

# Enforce preview defaults in Comfy user settings.
$PreviewSetupScript = Join-Path $ScriptPath "setup_comfyui_config.py"
if (Test-Path $PreviewSetupScript) {
    try {
        & $VenvPy "$PreviewSetupScript" 2>&1 | Out-Null
        Write-Step "Comfy preview defaults configured (auto live preview)." "Green"
    } catch {
        Write-Step "WARNING: Could not apply preview defaults (non-fatal)." "Yellow"
    }
}

# The graphs go where ComfyUI's own workflow browser can find them, so a user
# who wants to see how a workflow is built can open it rather than go looking
# for the file.
$PublishWorkflows = Join-Path $ScriptPath "publish_workflows.ps1"
if (Test-Path $PublishWorkflows) {
    # -Quiet so the script hands the line back instead of printing it, and
    # Write-Step puts it on screen and in the log like every other step.
    $Published = & $PublishWorkflows -RootPath $RootPath -Quiet
    if ($Published) { Write-Step $Published "Green" }
}

# Z-Image core models are NOT auto-downloaded during install.
# Users can run download_zimage_models.bat or ensure_zimage_core_models.ps1 manually if needed.
# (removed from auto-install per request)

# ============================================================================
# 7. SMOKE TEST
# ============================================================================
Write-Header "STEP 7/7 - Verification"

$SmokeCode = @"
import sys
ok = True
try:
    import torch
    gpu = torch.cuda.is_available()
    print(f'  PyTorch {torch.__version__} - CUDA: {gpu}')
    if gpu: print(f'  GPU: {torch.cuda.get_device_name(0)}')
    else: ok = False; print('  WARNING: CUDA not available!')
except Exception as e:
    ok = False; print(f'  PyTorch FAILED: {e}')

for lib in ['transformers', 'safetensors', 'numpy', 'PIL']:
    try:
        __import__(lib)
        print(f'  {lib}: OK')
    except:
        ok = False; print(f'  {lib}: FAILED')

# The backend has its own stack, and an install whose backend cannot start
# is not a working install. Checking only torch passed one anyway.
for lib in ['fastapi', 'uvicorn', 'requests', 'pydantic']:
    try:
        __import__(lib)
        print(f'  {lib}: OK')
    except:
        ok = False; print(f'  {lib}: FAILED - the backend will not start')

# Compiled, not imported. Importing it would build the app and read the
# several-megabyte object_info cache; compiling catches a file that arrived
# broken, which is the failure a smoke test is for.
import os, py_compile
_server = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       'backend', 'server.py')
if not os.path.isfile(_server):
    ok = False; print('  backend/server.py: MISSING')
else:
    try:
        py_compile.compile(_server, doraise=True)
        print('  backend/server.py: OK')
    except Exception as exc:
        ok = False; print(f'  backend/server.py: FAILED {exc}')

sys.exit(0 if ok else 1)
"@
$SmokeFile = Join-Path $RootPath "_smoke_test.py"
Set-Content -Path $SmokeFile -Value $SmokeCode
Write-Step "Running smoke test (PyTorch + CUDA import check)..." "Cyan"
& $VenvPy $SmokeFile
$SmokeExitCode = $LASTEXITCODE
Remove-Item $SmokeFile -Force

# The frontend is half the install and the smoke test only imports torch.
# A tester got "Smoke Test: PASSED" over a failed npm install, and the
# launcher then refused to start for want of node_modules - which is what
# run.ps1 checks, so it is what the verdict has to check too.
$FrontendOk = Test-Path (Join-Path $RootPath "frontend\node_modules")

if ($SmokeExitCode -eq 0) {
    Write-Step "All core imports verified!" "Green"
} else {
    Write-Step "Some imports failed - check output above." "Yellow"
}
if (-not $FrontendOk) {
    Write-Step "frontend\node_modules is missing - the app cannot start." "Red"
    Write-Step "See logs\npm_install.log, then run this installer again." "Yellow"
}

# ============================================================================
# INSTALL SUMMARY REPORT
# ============================================================================
$StopWatch.Stop()
$Elapsed = $StopWatch.Elapsed
$TimeStr = "{0:mm}m {0:ss}s" -f $Elapsed

$InstallReport = @()
$InstallReport += "Install Date:    $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$InstallReport += "Install Mode:    Main (Embedded Python + system Git/Node)"
$InstallReport += "Install Path:    $RootPath"
$InstallReport += "Install Time:    $TimeStr"
$InstallReport += ""

try { $PyVer = & $VenvPy --version 2>&1; $InstallReport += "Python:          $PyVer" } catch { $InstallReport += "Python:          UNKNOWN" }
try { $PipVer = & $VenvPy -m pip --version 2>&1; $InstallReport += "Pip:             $($PipVer -replace ' from .*','')" } catch {}
try { $NodeVer = & node --version 2>&1; $InstallReport += "Node.js:         $NodeVer" } catch {}
try { $GitVer = & git --version 2>&1; $InstallReport += "Git:             $GitVer" } catch {}

try {
    $TorchInfo = & $VenvPy -c "import torch; print(f'PyTorch {torch.__version__} | CUDA: {torch.cuda.is_available()} | Device: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else ""N/A""}')" 2>&1
    $InstallReport += "PyTorch:         $TorchInfo"
} catch {}

# The card, and whether torch was built for it.
#
# torch 2.10+cu130 carries sm_75 80 86 90 100 120 and no PTX. sm_89 - every
# RTX 40 - is not in that list and runs on the sm_86 cubins, which CUDA allows
# within a major version. It works, but it is worth reading off the machine
# rather than reasoning about later, and no PTX means a card newer than this
# list cannot JIT its way out.
$GpuProbe = @'
import torch
if not torch.cuda.is_available():
    print("GPU:             CUDA not available - check the NVIDIA driver")
else:
    maj, minr = torch.cuda.get_device_capability(0)
    me = "sm_%d%d" % (maj, minr)
    archs = torch.cuda.get_arch_list()
    vram = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
    print("GPU:             %s  (%s, %.0f GB)" % (torch.cuda.get_device_name(0), me, vram))
    print("Torch archs:     %s" % " ".join(archs))
    if me in archs:
        print("Arch match:      native")
    else:
        # Numeric, not string: "sm_90" sorts below "sm_89" lexically, which
        # happens not to matter for today's values and would quietly give the
        # wrong answer for tomorrow's.
        num = lambda a: int(a.split("_")[1])
        same = sorted([a for a in archs if a.startswith("sm_%d" % maj)
                       and num(a) <= num(me)], key=num)
        if same:
            print("Arch match:      %s absent - runs on %s (minor compatibility)" % (me, same[-1]))
        else:
            print("Arch match:      *** %s NOT SUPPORTED by this torch build ***" % me)
'@
try {
    $GpuProbe | Set-Content -LiteralPath "$env:TEMP\fedda_gpu.py" -Encoding ASCII
    $GpuLines = & $VenvPy "$env:TEMP\fedda_gpu.py" 2>&1
    foreach ($l in $GpuLines) { $InstallReport += "$l" }
    Remove-Item "$env:TEMP\fedda_gpu.py" -Force -ErrorAction SilentlyContinue
} catch { $InstallReport += "GPU:             probe failed" }

# The driver, because "CUDA: False" on somebody else's PC is a driver version
# more often than it is anything this installer did.
try {
    $Drv = (& nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>$null | Select-Object -First 1)
    if ($Drv) { $InstallReport += "NVIDIA driver:   $($Drv.Trim())" }
} catch {}

$InstallReport += ""
# One line, both halves. The quick-launch gate reads this and nothing else,
# so a PASSED here has to mean the whole install and not just the Python.
if ($SmokeExitCode -eq 0 -and $FrontendOk) {
    $InstallReport += "Smoke Test:      PASSED"
} else {
    $InstallReport += "Smoke Test:      FAILED"
    if ($SmokeExitCode -ne 0) { $InstallReport += "  - Python imports failed" }
    if (-not $FrontendOk)     { $InstallReport += "  - frontend/node_modules missing (see logs/npm_install.log)" }
}

# Sixty-two packs install now, so a report that does not mention them is
# describing the smaller half of what happened.
$InstallReport += ""
$InstallReport += "Node packs:      $Installed installed, $Skipped already present, $Failed failed"
if ($DepsFailed.Count) {
    $InstallReport += "  Deps failed:   $($DepsFailed -join ', ')"
    foreach ($w in $DepsWhy) { $InstallReport += "    $w" }
    $InstallReport += "                 (those nodes may not load - run.bat repair retries them)"
}

# Which version they are on. "It does not work" cannot be answered without it.
try {
    $Rev = (& git -C $RootPath rev-parse --short HEAD 2>$null)
    if ($Rev) { $InstallReport += "FEDDA commit:    $($Rev.Trim())" }
} catch {}

# The cheap context that explains a good share of the rest.
try {
    $Os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $InstallReport += "Windows:         $($Os.Caption) build $($Os.BuildNumber)"
    $InstallReport += "RAM:             {0:N0} GB" -f ($Os.TotalVisibleMemorySize / 1MB)
} catch {}
try {
    $Drive = (Get-Item $RootPath).PSDrive
    $InstallReport += "Free disk:       {0:N0} GB on {1}:" -f ($Drive.Free / 1GB), $Drive.Name
} catch {}

$InstallReport += ""
$InstallReport += "Log Files:"
$InstallReport += "  Report:  $(Join-Path $LogsDir 'install_report.txt')"
$InstallReport += "  Full:    $(Join-Path $LogsDir 'install_fast_log.txt')"

# Write report
$LogsDir = Join-Path $RootPath "logs"
if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir | Out-Null }
$ReportFile = Join-Path $LogsDir "install_report.txt"
[System.IO.File]::WriteAllLines(
    $ReportFile, [string[]]$InstallReport, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
foreach ($Line in $InstallReport) { Write-Host "  $Line" }

Write-Host ""
Write-Host "  ========================================================" -ForegroundColor Green
Write-Host "         INSTALLATION COMPLETE!                           " -ForegroundColor Green
Write-Host "         Time: $TimeStr                                   " -ForegroundColor Green
Write-Host "         Report: $ReportFile                              " -ForegroundColor Green
Write-Host "         Run: RUN.bat                                     " -ForegroundColor Green
Write-Host "  ========================================================" -ForegroundColor Green
Write-Host ""

# No "what happens next" here. This is the innermost of three layers that each
# used to announce completion, and there is nothing left to explain now that
# every pack installs above.
