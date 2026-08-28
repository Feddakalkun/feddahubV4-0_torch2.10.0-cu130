param(
    [Parameter(Mandatory = $true)][string]$RootPath,
    [switch]$Quiet
)

# Put FEDDA's workflow graphs where ComfyUI's own workflow browser can open them.
#
# They are API format - {"1": {"inputs": ..., "class_type": ...}} - which is what
# the backend submits to /prompt. The ComfyUI frontend detects that and rebuilds
# a graph from it (isApiJson / loadApiJson, verified in 1.48.7), so they open;
# what they do not carry is the original layout, groups or node titles, because
# an API export never had them.
#
# Everything lands under a single FEDDA folder rather than being scattered across
# the browser's root next to whatever the user saved themselves. That also makes
# the mirror safe: the folder is ours alone, so it can be replaced wholesale, and
# a graph deleted from the repo stops appearing in ComfyUI instead of lingering
# as an entry that no longer runs.

$ErrorActionPreference = "Stop"

$Source = Join-Path $RootPath "backend\workflows"
$Dest   = Join-Path $RootPath "ComfyUI\user\default\workflows\FEDDA"

function Say([string]$Text, [string]$Colour = "Green") {
    if (-not $Quiet) { Write-Host "  $Text" -ForegroundColor $Colour }
}

# Prints for a human, and hands the same line back to the caller so it can be
# written to a log. Only under -Quiet, so a caller that is not capturing does
# not see the line twice.
#
# This step was the one part of the install that left no trace: it wrote with
# Write-Host, which never reaches the log file, so a failure here would have
# been invisible in exactly the file someone reads to find out what went wrong.
function Report([string]$Text, [string]$Colour = "Green") {
    Say $Text $Colour
    if ($Quiet) { Write-Output $Text }
}

if (-not (Test-Path $Source)) {
    Say "No workflows folder to publish - skipped." "Yellow"
    return
}

try {
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null

    # Graphs only, each under the folder it came from. Copying the tree wholesale
    # brings empty directories along - a folder whose last graph was deleted is
    # still a folder - and an empty entry in the browser is a promise of nothing.
    # [char]92 is a backslash. Spelled this way because a literal one here has
    # not survived every tool that has edited this file.
    $Prefix = (Resolve-Path $Source).Path.TrimEnd([char]92)
    $Count = 0
    foreach ($File in Get-ChildItem -Path $Source -Recurse -Filter *.json -File) {
        $Relative = $File.FullName.Substring($Prefix.Length).TrimStart([char]92)
        $Target = Join-Path $Dest $Relative
        $Folder = Split-Path $Target -Parent
        if (-not (Test-Path $Folder)) { New-Item -ItemType Directory -Force -Path $Folder | Out-Null }
        Copy-Item -Path $File.FullName -Destination $Target -Force
        $Count++
    }
    Report "$Count workflows published to ComfyUI's browser."
} catch {
    # A user with ComfyUI open can hold a file handle, and a copy that cannot
    # finish is not a reason to fail an install that otherwise worked.
    Report "WARNING: could not publish workflows to ComfyUI (non-fatal): $_" "Yellow"
}
