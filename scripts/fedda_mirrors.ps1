# Where FEDDA can be fetched from, in order.
#
# Its own file because two scripts need the answer and they must not disagree:
# update_code.ps1 when it fetches, and run.ps1 when it decides whether to offer
# an update at all. Copying the list into both is how the launcher ends up
# checking a source the updater no longer uses - it would go quiet while
# updates kept arriving somewhere else.
#
# Dot-sourced, so it defines a function and does nothing else. update_code.ps1
# starts an update the moment it is loaded; that is why the function could not
# simply live there.

function Get-FeddaMirrors {
    <#
        config/mirrors.json is the source of truth so the list can be changed by
        an update; the values below are for a clone made before that file
        existed, and for a tree that is mid-update and missing it.
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
