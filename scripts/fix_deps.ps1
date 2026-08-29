<#
    Repair the python packages a node pack downgraded on its way in.

    A pack's requirements.txt is installed as written, and some of them pin a
    version that was right when the pack was published and is wrong beside the
    rest of this install. The pack gets what it asked for, something else
    breaks, and the error surfaces hours later somewhere unrelated.

    v3 answered this with five patch_*.ps1 scripts, one per incident. This is
    one file with one list, run after nodes are installed at both install and
    update time - so a fix cannot apply on a fresh install and quietly not on an
    updated one, which is how the two drift apart.

    Add to the list only what has actually broken, with the pack that caused it
    named. A guess here is a version pin nobody can justify later.
#>

param(
    [Parameter(Mandatory = $true)][string] $PyExe,
    [switch] $Quiet
)

$ErrorActionPreference = "Continue"

function Say($Message, $Colour = "Gray") {
    if (-not $Quiet) { Write-Host "  $Message" -ForegroundColor $Colour }
}

# --- kornia -----------------------------------------------------------------
#
# ComfyUI-LTXVideo imports `pad` from kornia.geometry.transform.pyramid. kornia
# 0.8.3 dropped that import - `pad` is a local variable in the module now - so
# the pack fails at import and takes all three of its node types with it:
#
#   cannot import name 'pad' from 'kornia.geometry.transform.pyramid'
#
# What that costs is five LTX workflows, and nothing says so at the time. The
# pack still loads its own folder, ComfyUI carries on, and the failure only
# shows as "node type not found" when someone presses Generate.
#
# 0.8.2 is the last version that exports it, checked against kornia's own
# source for 0.7.3 through 0.8.3. ComfyUI core asks for kornia>=0.7.1, so
# holding at 0.8.2 satisfies both. The pin is pinned upstream HEAD, so there is
# no newer pack commit to move to instead.
$NeedKornia = & $PyExe -c @"
try:
    from kornia.geometry.transform.pyramid import pad  # noqa: F401
    print('no')
except Exception:
    print('yes')
"@ 2>$null

if ("$NeedKornia".Trim() -eq "yes") {
    Say "kornia is too new for ComfyUI-LTXVideo - holding at 0.8.2..." "Yellow"
    & $PyExe -s -m pip install --no-input --no-warn-script-location `
        "kornia==0.8.2" 2>&1 | Out-Null
    $after = & $PyExe -c "from kornia.geometry.transform.pyramid import pad; import kornia; print(kornia.__version__)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $after) {
        Say "kornia $($after.Trim()) - LTXVideo can import again." "Green"
    } else {
        Say "kornia still will not give LTXVideo its pad - five LTX workflows stay broken." "Red"
    }
} else {
    Say "kornia is fine." "DarkGray"
}

# --- onnxruntime -------------------------------------------------------------
#
# ComfyUI-tbox pins onnxruntime==1.18.0 and onnxruntime-gpu==1.18.0. That build
# was compiled against NumPy 1.x, and this install ships NumPy 2, so importing
# it raises "AttributeError: _ARRAY_API not found" - which takes down tbox
# itself, and DWPose with it, so ControlNet Pose stops working. The pack breaks
# its own dependency.
#
# 1.20 is the first release built for NumPy 2.
$Need = & $PyExe -c @"
import sys
try:
    import numpy, onnxruntime
    major = int(numpy.__version__.split('.')[0])
    parts = [int(p) for p in onnxruntime.__version__.split('.')[:2]]
    # Too old for this NumPy, or importable but mismatched.
    print('yes' if (major >= 2 and (parts[0], parts[1]) < (1, 20)) else 'no')
except ImportError:
    # onnxruntime that cannot even be imported is exactly the broken case.
    print('yes')
except Exception:
    print('no')
"@ 2>$null

if ("$Need".Trim() -eq "yes") {
    Say "onnxruntime is too old for the installed NumPy - reinstalling..." "Yellow"
    & $PyExe -s -m pip install --no-input --no-warn-script-location --upgrade `
        "onnxruntime>=1.20" "onnxruntime-gpu>=1.20" 2>&1 | Out-Null
    $after = & $PyExe -c "import onnxruntime; print(onnxruntime.__version__)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $after) {
        Say "onnxruntime $($after.Trim()) - imports cleanly." "Green"
    } else {
        Say "onnxruntime still will not import - DWPose and ControlNet Pose stay broken." "Red"
    }
} else {
    Say "onnxruntime is fine." "DarkGray"
}
