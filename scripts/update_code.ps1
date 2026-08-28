# ============================================================================
# FEDDA Code Update - Fast, minimal, pulls the latest code from `origin`,
# whichever source that is: the domain mirror, GitHub, or a local clone.
# Used by auto-update in run.bat - focused on speed
# For full maintenance (custom nodes, deps), see update_logic.ps1
# ============================================================================

param([switch]$SilentMode)

# The mirror list lives in fedda_mirrors.ps1 so run.ps1 can read the same
# one without loading this file, which starts an update the moment it is
# sourced. The inline copy below is the fallback for a tree that is
# mid-update and does not have the shared file yet.
$FeddaMirrorHelper = Join-Path $PSScriptRoot "fedda_mirrors.ps1"
if (Test-Path $FeddaMirrorHelper) { . $FeddaMirrorHelper }
if (-not (Get-Command Get-FeddaMirrors -ErrorAction SilentlyContinue)) {
function Get-FeddaMirrors {
    <#
        Where FEDDA can be fetched from, in order. config/mirrors.json is the
        source of truth so the list can be changed by an update; the values
        below are for a clone made before that file existed.
    #>
    $file = Join-Path $PSScriptRoot "..\config\mirrors.json"
    if (Test-Path $file) {
        try {
            $urls = (Get-Content $file -Raw | ConvertFrom-Json).mirrors
            if ($urls -and $urls.Count -gt 0) { return @($urls) }
        } catch { }
    }
    return @(
        "https://feddakalkun.com/fedda.git",
        "https://github.com/Feddakalkun/feddahubV3-0_torch2.10.0-cu130.git"
    )
}
}

$ErrorActionPreference = "Stop"
$ScriptPath = $PSScriptRoot
$RootPath = Split-Path -Parent $ScriptPath
Set-Location $RootPath

# Start unified log — captures git pull + all node/dep steps in one file
$LogDir = Join-Path $RootPath "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir "update.log"
$FeddaTranscriptOwner = $true  # tells update_logic.ps1 not to start its own transcript
try { Start-Transcript -Path $LogFile -Append -Force | Out-Null } catch {}
Write-Host "=== FEDDA Update started: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" -ForegroundColor DarkGray
Write-Host "Log file: $LogFile" -ForegroundColor DarkGray

if (-not $SilentMode) {
    Write-Host "`n===================================================" -ForegroundColor Cyan
    Write-Host "  FEDDA CODE UPDATE" -ForegroundColor Cyan
    Write-Host "===================================================" -ForegroundColor Cyan
}

# ============================================================================
# GIT SETUP
# ============================================================================
$GitEmbedded = Join-Path $RootPath "git_embeded\cmd\git.exe"
if (Test-Path $GitEmbedded) {
    $GitExe = $GitEmbedded
    $env:PATH = "$(Split-Path $GitExe);$env:PATH"
} else {
    $GitExe = "git"
}

# Never let git PAUSE the update for input — no pager, no merge editor, no auth prompt.
# A git pager (less) / editor / credential prompt is what was freezing update.bat and
# forcing "press a key to continue" over and over. These env vars propagate into the
# dot-sourced update_logic.ps1 (same session), so the whole update stays non-interactive.
$env:GIT_PAGER = 'cat'
$env:GIT_EDITOR = 'true'
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'

# Fix dubious ownership errors (local config only - never modify user's global gitconfig)
$env:GIT_CONFIG_GLOBAL = Join-Path $RootPath ".gitconfig"
& $GitExe config --file "$env:GIT_CONFIG_GLOBAL" --add safe.directory '*' 2>$null

# ============================================================================
# 1. CHECK IF GIT REPO EXISTS
# ============================================================================
if (-not (Test-Path (Join-Path $RootPath ".git"))) {
    if (-not $SilentMode) {
        Write-Host "`n  Initializing git from the update source..." -ForegroundColor Yellow
    }
    & $GitExe init
    & $GitExe remote add origin $(Get-FeddaMirrors)[0]
}

# ============================================================================
# 2. PULL LATEST CODE
# ============================================================================
if (-not $SilentMode) {
    Write-Host "`n  Pulling the latest code..." -ForegroundColor Yellow
    # Stash local changes to protect uncommitted work (including new files like workflows)
    $hasChanges = & $GitExe status --porcelain 2>$null
    if ($hasChanges) {
        if (-not $SilentMode) { Write-Host "  Stashing local changes to protect them..." -ForegroundColor Yellow }
        $ErrorActionPreference = "Continue"
        & $GitExe stash push -u -m "auto-stash-before-update-$(Get-Date -Format yyyyMMddHHmmss)" 2>&1 | Out-Null
        $ErrorActionPreference = "Stop"
    }
}

try {
    # "Continue" for the whole git section, not just parts of it.
    #
    # PowerShell 5.1 turns a native program's stderr into an ErrorRecord, and
    # under Stop that record is terminating. git announces where it fetched
    # from on stderr, so a successful `git fetch` killed the update with
    # "TerminatingError(git.exe): ... From https://feddakalkun.com/fedda".
    #
    # Every call below checks $LASTEXITCODE and throws on a real failure.
    # That is git reporting failure; stderr is git talking.
    $ErrorActionPreference = "Continue"
    # Try every mirror, not just origin. One host removing the repository
    # should cost a retry, not the whole distribution - and repointing here
    # means an install fixes itself instead of needing to be found and told.
    $Mirrors = Get-FeddaMirrors
    $Current = (& $GitExe remote get-url origin 2>$null)
    if ($Current) { $Mirrors = @($Current) + ($Mirrors | Where-Object { $_ -ne $Current }) }

    $FetchedFrom = ""
    foreach ($Url in $Mirrors) {
        & $GitExe fetch $Url main 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $FetchedFrom = $Url; break }
        if (-not $SilentMode) {
            Write-Host "  $Url did not answer - trying the next source..." -ForegroundColor DarkGray
        }
    }
    if (-not $FetchedFrom) { throw "git fetch failed" }

    if ($FetchedFrom -ne $Current) {
        # Adopt it, so the next update starts where this one succeeded.
        & $GitExe remote set-url origin $FetchedFrom 2>&1 | Out-Null
        if (-not $SilentMode) {
            Write-Host "  Source switched to $FetchedFrom" -ForegroundColor Yellow
        }
    }
    & $GitExe fetch origin main 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "git fetch failed"
    }
    # Commits that exist here and nowhere else. On an install there are none
    # and this costs a millisecond; on the machine the work is done on, a
    # reset --hard would erase them, and this update already did exactly that
    # to three of them while printing "Code updated successfully".
    # A shallow clone cannot answer this. The installer clones with --depth 1,
    # so HEAD is a grafted root: it has no parent, nothing descends from
    # anything, and the count below returns 1 for every user on every update.
    # A fresh install refused its own first update this way.
    $Shallow = & $GitExe rev-parse --is-shallow-repository 2>$null
    $CanCompare = ($LASTEXITCODE -eq 0 -and "$Shallow".Trim() -ne "true")

    # And an unrelated root is a rewritten remote, not local work - publishing a
    # fix to a repository with a single amended commit does exactly that. Only a
    # HEAD that shares history with origin can be meaningfully "ahead" of it.
    if ($CanCompare) {
        & $GitExe merge-base HEAD origin/main *> $null
        $CanCompare = ($LASTEXITCODE -eq 0)
    }

    $Ahead = if ($CanCompare) { & $GitExe rev-list --count origin/main..HEAD 2>$null } else { 0 }
    if ($CanCompare -and $LASTEXITCODE -eq 0 -and $Ahead -and [int]$Ahead -gt 0) {
        if (-not $SilentMode) {
            Write-Host ""
            Write-Host "  [STOP] This clone has $Ahead commit(s) that are not on GitHub." -ForegroundColor Yellow
            Write-Host "         Updating would reset the code and destroy them." -ForegroundColor Yellow
            Write-Host "         Push or remove them first, then update again." -ForegroundColor Yellow
            & $GitExe --no-pager log --oneline "origin/main..HEAD"
            Write-Host ""
        }
        # Not 0. Returning plainly here reads as success to the caller,
        # and the launcher went on to say the update had finished.
        exit 2
    }

    # What this update is about to change. Recorded before the reset, because
    # afterwards there is nothing left to compare against.
    $HeadBefore = (& $GitExe rev-parse HEAD 2>$null)

    & $GitExe reset --hard origin/main 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "git reset failed"
    }
    & $GitExe clean -fd 2>&1 | Out-Null

    # Hand the file list to update_logic.ps1 so it can skip work nothing asked
    # for. Written even when empty - an empty file means "nothing changed",
    # while a missing one means "could not tell", and those are different
    # answers that must lead to different behaviour.
    $ChangedFile = Join-Path $RootPath "logs\.update_changed.txt"
    $HeadAfter = (& $GitExe rev-parse HEAD 2>$null)
    if ($HeadBefore -and $HeadAfter) {
        $Changed = & $GitExe diff --name-only "$($HeadBefore.Trim())" "$($HeadAfter.Trim())" 2>$null
        if ($LASTEXITCODE -eq 0) {
            ($Changed | Out-String).Trim() | Out-File $ChangedFile -Encoding utf8 -Force
        } else {
            Remove-Item $ChangedFile -Force -ErrorAction SilentlyContinue
        }
    } else {
        Remove-Item $ChangedFile -Force -ErrorAction SilentlyContinue
    }

    # Past every native call, so PowerShell may treat errors as fatal again.
    $ErrorActionPreference = "Stop"
    
    if (-not $SilentMode) {
        Write-Host "  [OK] Code updated successfully." -ForegroundColor Green
        if ($hasChanges) { if (-not $SilentMode) { Write-Host "  (Your local changes were stashed - use git stash pop to restore)" -ForegroundColor Yellow } }
    }
} catch {
    if (-not $SilentMode) {
        Write-Host "  [WARN] Git update failed: $_" -ForegroundColor Yellow
    }
    exit 1
}

# ============================================================================
# 3. RUN FULL MAINTENANCE (nodes, deps, frontend)
# ============================================================================
$UpdateLogic = Join-Path $ScriptPath "update_logic.ps1"
if (-not (Test-Path $UpdateLogic)) {
    # Fallback: PSScriptRoot can be empty in some invocation paths; derive from RootPath
    $UpdateLogic = Join-Path $RootPath "scripts\update_logic.ps1"
}
if (Test-Path $UpdateLogic) {
    if (-not $SilentMode) {
        Write-Host "`n  Running full maintenance (nodes, deps, frontend)..." -ForegroundColor Yellow
    }
    # Dot-source so transcript captures all output in the same session
    if ($SilentMode) {
        . "$UpdateLogic" -SilentMode
    } else {
        . "$UpdateLogic"
    }
} else {
    Write-Host "`n  [WARN] update_logic.ps1 not found (checked: $UpdateLogic)" -ForegroundColor Yellow
}

# ============================================================================
# DONE
# ============================================================================
Write-Host "=== FEDDA Update finished: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" -ForegroundColor DarkGray
try { Stop-Transcript | Out-Null } catch {}

if (-not $SilentMode) {
    Write-Host "`n===================================================" -ForegroundColor Green
    Write-Host "  UPDATE COMPLETE" -ForegroundColor Green
    Write-Host "===================================================" -ForegroundColor Green
}

exit 0
