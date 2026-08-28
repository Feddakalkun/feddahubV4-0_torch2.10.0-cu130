"""Validate every workflow JSON before it can waste anyone's time.

Catches the two failures that look identical from the UI but have different causes:

1. NULL class_type - the workflow was saved while it still contained subgraphs,
   node groups, or virtual-link nodes (cg-use-everywhere "Anything Everywhere").
   Those serialize as {"inputs": ..., "_meta": ...} with no class_type at all.
   ComfyUI rejects the prompt with:
       "Node 'ID #4' has no class_type. The workflow may be corrupted..."
   The graph can look perfect in the canvas and still export dead.

2. MISSING class_type - the node type is fine but its custom-node pack is not
   installed. ComfyUI says:
       "Node 'X' not found. The custom node may not be installed."
   Note it reports the node TITLE, not the class, so the message often names
   something like "Load Diffusion Model" when the real class is UnetLoaderGGUF.

The important part is that a naive check reports (1) as healthy: if you collect
class_types with a truthiness filter, the broken nodes are silently skipped and
every surviving node resolves. This script counts them explicitly.

Usage:
    python scripts/validate_workflows.py              # all registered workflows
    python scripts/validate_workflows.py path.json    # one file, even unregistered
    python scripts/validate_workflows.py --strict     # exit 1 if anything is broken

Node availability is checked against a live ComfyUI on COMFY_URL (default
127.0.0.1:8199). If it is not running, structural checks still run and the
availability check is skipped rather than failing the whole run.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF_DIR = os.path.join(ROOT, "backend", "workflows")
API_MAP = os.path.join(ROOT, "config", "workflow_api.json")
MODULES = os.path.join(ROOT, "config", "modules.json")
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8199")


def load_json(path):
    with open(path, encoding="utf-8-sig") as fh:
        return json.load(fh)


def available_node_types():
    """Node types ComfyUI currently has loaded, or None if it isn't running."""
    try:
        with urllib.request.urlopen(COMFY_URL + "/object_info", timeout=120) as r:
            return set(json.load(r).keys())
    except (urllib.error.URLError, OSError, ValueError):
        return None


def inspect(path, available):
    """Return (nulls, missing, class_types) for one workflow file."""
    try:
        data = load_json(path)
    except Exception as exc:
        return None, None, str(exc)

    nodes = data.get("nodes") or data
    if isinstance(nodes, list):
        return None, None, "UI format (nodes is a list) - not API format, cannot run"
    if not isinstance(nodes, dict):
        return None, None, "unrecognised structure"

    nulls, types = [], set()
    for nid, node in nodes.items():
        if not isinstance(node, dict):
            nulls.append(nid)
            continue
        ct = node.get("class_type")
        if ct:
            types.add(ct)
        else:
            nulls.append(nid)

    missing = sorted(t for t in types if t not in available) if available else []
    return nulls, missing, types


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--strict"]
    strict = "--strict" in sys.argv

    available = available_node_types()
    if available is None:
        print("! ComfyUI not reachable at %s - checking structure only\n" % COMFY_URL)
    else:
        print("ComfyUI has %d node types loaded\n" % len(available))

    # Build the list to check: explicit paths, else every registered workflow.
    targets = []
    if args:
        for a in args:
            targets.append((os.path.basename(a), a if os.path.isabs(a) else os.path.join(ROOT, a)))
    else:
        api = load_json(API_MAP)
        for wid, meta in sorted(api.items()):
            fn = meta.get("filename")
            if fn:
                targets.append((wid, os.path.join(WF_DIR, *fn.split("/"))))

    broken, ok = [], 0
    for wid, path in targets:
        if not os.path.exists(path):
            broken.append((wid, "FILE MISSING", path))
            continue
        nulls, missing, types = inspect(path, available)
        if nulls is None:
            # `types` carries the reason string here. Report it verbatim instead of
            # a blanket "UNREADABLE": "UI format" means the file just needs
            # re-saving via Save (API Format), which is a completely different fix
            # from a parse error.
            broken.append((wid, "NOT USABLE", str(types)))
            continue
        if nulls:
            broken.append((wid, "NULL class_type on %d node(s)" % len(nulls),
                           "nodes " + ", ".join(nulls[:12]) + (" ..." if len(nulls) > 12 else "")))
        elif missing:
            broken.append((wid, "MISSING %d node type(s)" % len(missing), ", ".join(missing[:8])))
        else:
            ok += 1

    for wid, kind, detail in broken:
        print("  [BROKEN] %-26s %s" % (wid, kind))
        print("           %s" % detail)

    # Be explicit about which checks actually ran. Reporting a plain "N ok" when
    # ComfyUI was unreachable is a lie by omission: only the structural half ran,
    # and a workflow missing half its custom nodes gets counted as fine. That
    # exact wording ("44 ok, 2 broken") hid 28 broken workflows until ComfyUI came
    # back up and the same tree reported 16 ok, 30 broken.
    if available is None:
        print("\n%d structurally ok, %d broken, %d checked" % (ok, len(broken), len(targets)))
        print("!! NODE AVAILABILITY WAS NOT CHECKED - ComfyUI was not running at %s." % COMFY_URL)
        print("!! 'structurally ok' here means only: parses, and no null class_type.")
        print("!! Workflows needing uninstalled custom nodes are NOT detected. Re-run with ComfyUI up.")
    else:
        print("\n%d ok, %d broken, %d checked" % (ok, len(broken), len(targets)))

    if broken:
        print("\nNULL class_type => re-export from ComfyUI: ungroup subgraphs and replace")
        print("  virtual-link nodes (Anything Everywhere) with real wires, then Save (API Format).")
        print("MISSING node type => install the pack, and declare it in config/modules.json")
        print("  under the module that owns the workflow (see %s)." % os.path.relpath(MODULES, ROOT))

    if strict and available is None:
        # Under --strict an incomplete check must not pass as success, or gating
        # install/update on this would wave through workflows whose packs are absent.
        print("\n--strict: failing because node availability could not be checked.")
        return 2
    return 1 if (broken and strict) else 0


if __name__ == "__main__":
    sys.exit(main())
