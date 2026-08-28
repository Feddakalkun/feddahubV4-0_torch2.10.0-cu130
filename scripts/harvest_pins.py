"""Read version pins out of a ComfyUI install that is known to work.

V3 cloned every custom node at HEAD. That is how you end up maintaining five
`patch_*.ps1` scripts: a pack changes upstream, the workflow that depended on
it stops loading, and the fix is a patch against whatever arrived that week.
The install is then only reproducible by accident.

A working install already holds the answer. Each pack there was installed one
of two ways, and both leave a record:

  git       the clone is right there - `rev-parse HEAD` is the pin
  registry  ComfyUI Manager's newer path. No git, but `pyproject.toml`
            carries the version the registry served

So the pin is harvested, not invented, and it points at a combination someone
has actually generated pictures with.

    python scripts/harvest_pins.py "E:/Comfyuistudiov362/App/ComfyUI"
    python scripts/harvest_pins.py <comfyui-dir> --write

`--write` merges what it found into config/node_catalog.json, touching only the
`pin` and `pin_source` fields and only for packs already listed there. It never
adds a pack: what to ship is decided by require_nodes.py from the workflows,
not by what happens to be installed on one machine.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "config" / "node_catalog.json"

VERSION_RE = re.compile(r'^\s*version\s*=\s*["\']([^"\']+)["\']', re.MULTILINE)


def pin_for(folder: Path) -> Tuple[Optional[str], Optional[str]]:
    """(pin, how) for one installed pack, or (None, None) if it says nothing."""
    if (folder / ".git").is_dir():
        try:
            out = subprocess.run(["git", "-C", str(folder), "rev-parse", "HEAD"],
                                 capture_output=True, text=True, timeout=30)
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.strip(), "git"
        except (OSError, subprocess.SubprocessError):
            pass
    pyproject = folder / "pyproject.toml"
    if pyproject.is_file():
        try:
            match = VERSION_RE.search(pyproject.read_text(encoding="utf-8",
                                                          errors="ignore"))
        except OSError:
            match = None
        if match:
            return match.group(1), "registry"
    return None, None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("comfyui", help="a ComfyUI directory that works")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--label", help="name to record as the pin's origin")
    args = ap.parse_args()

    nodes_dir = Path(args.comfyui) / "custom_nodes"
    if not nodes_dir.is_dir():
        raise SystemExit(f"No custom_nodes under {args.comfyui}")
    reference = args.label or Path(args.comfyui).resolve().parent.parent.name

    catalog = json.loads(CATALOG.read_text(encoding="utf-8-sig"))
    by_folder = {str(e.get("folder", "")).lower(): e for e in catalog}

    found: Dict[str, Any] = {}
    for child in sorted(nodes_dir.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        pin, how = pin_for(child)
        if pin:
            # Which install a pin came from decides how much it is worth. One
            # taken from an install running a different ComfyUI or torch is a
            # hint; one from the build this ships against is a guarantee. Run
            # the weaker reference first and the stronger second - later wins.
            found[child.name] = {"pin": pin, "pin_source": how,
                                 "pin_from": reference}

    hits = [(name, v) for name, v in found.items() if name.lower() in by_folder]
    print(f"  {len(found)} pack(s) with a pin, {len(hits)} of them in the catalog")

    changed = 0
    for name, value in sorted(hits, key=lambda kv: kv[0].lower()):
        entry = by_folder[name.lower()]
        was = entry.get("pin")
        # An unchanged pin with no recorded origin still needs the origin: it
        # is the case where knowing the reference matters most, because a pin
        # this install did not confirm is the weaker kind.
        stale = was != value["pin"] or not entry.get("pin_from")
        print(f"   {' ' if not stale else '*'} {name:<32} "
              f"{value['pin_source']:<9} {value['pin'][:16]}")
        if stale:
            entry.update(value)
            changed += 1

    missing = [e["folder"] for e in catalog
               if e["folder"].lower() not in {n.lower() for n, _ in hits}]
    if missing:
        print(f"\n  no pin available for {len(missing)}: "
              + ", ".join(sorted(missing)[:8]))
        print("  (not installed in that ComfyUI, or installed with no version record)")

    if args.write and changed:
        CATALOG.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n",
                           encoding="utf-8")
        print(f"\n  wrote {changed} pin(s) into {CATALOG.relative_to(ROOT)}")
    elif args.write:
        print("\n  nothing to change")
    elif changed:
        print(f"\n  {changed} pin(s) would change - pass --write to apply")


if __name__ == "__main__":
    main()
