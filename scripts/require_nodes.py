"""Derive the custom-node list from the workflows that are actually shipped.

V3 kept `nodes.json` by hand. It reached sixty packs, twenty-two of which no
workflow anywhere referenced, and four of those sat inside the *core* module -
the one thing that is supposed to stay small. A hand-kept list only grows,
because removing an entry means proving a negative and nobody does that on a
Tuesday.

So it is computed instead. ComfyUI's `/object_info` reports a `python_module`
for every node type it knows - `custom_nodes.rgthree-comfy` and so on - which
turns "which packs does this workflow need" into a lookup rather than a guess.

Two files, and only one of them is written:

  config/node_catalog.json   every pack we know a URL for. Reference only;
                             nothing here installs. Edit this by hand.
  config/nodes.json          what the installer clones. DERIVED - do not edit.

Usage:

    python scripts/require_nodes.py                    # rewrite config/nodes.json
    python scripts/require_nodes.py --modules          # also per-module lists
    python scripts/require_nodes.py --check            # fail if out of date

`--check` is for the publish step: it makes a stale `nodes.json` a failure
rather than a surprise for whoever installs next.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Set

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / "backend" / "workflows"
CATALOG = ROOT / "config" / "node_catalog.json"
OVERRIDES = ROOT / "config" / "node_overrides.json"
NODES = ROOT / "config" / "nodes.json"
MODULES = ROOT / "config" / "modules.json"
CACHE = ROOT / "config" / "object_info.cache.json"

# Packs the app needs whatever workflows are installed. Manager is the user's
# own way out when something is missing, and Studio-nodes carries
# HuggingFaceDownloader - the node FEDDA reads a workflow's models from, so
# without it a workflow cannot say what it needs.
ALWAYS = ["ComfyUI-Manager", "ComfyUI-Studio-nodes"]


def object_info(comfy: str | None) -> Dict[str, Any]:
    if comfy:
        try:
            with urllib.request.urlopen(f"{comfy}/object_info", timeout=60) as r:
                info = json.loads(r.read().decode("utf-8", "ignore"))
            CACHE.write_text(json.dumps(info), encoding="utf-8")
            return info
        except (OSError, ValueError):
            pass
    if CACHE.exists():
        return json.loads(CACHE.read_text(encoding="utf-8"))
    sys.exit("No object_info. Start ComfyUI once, or pass --comfy.")


def load_overrides() -> Dict[str, str]:
    """Node type -> pack, for types this ComfyUI has never seen.

    A class_type is resolved through object_info's python_module. One that is
    not installed here resolves to nothing, and the pack that provides it then
    quietly fails to reach nodes.json - which ships a workflow whose node is
    missing, and the failure surfaces as "node not found" on a user's machine
    rather than here. MiniMax H3's VHS_VideoCombine was the first case.
    """
    if not OVERRIDES.exists():
        return {}
    data = json.loads(OVERRIDES.read_text(encoding="utf-8-sig"))
    return {k: str(v) for k, v in (data.get("overrides") or {}).items()}


def packs_for(graphs: List[Path], info: Dict[str, Any]) -> tuple[Set[str], Set[str]]:
    """Which packs these graphs need, and which node types nothing here knows."""
    overrides = load_overrides()
    packs: Set[str] = set()
    unknown: Set[str] = set()
    for f in graphs:
        try:
            graph = json.loads(f.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            continue
        if not isinstance(graph, dict):
            continue
        for node in graph.values():
            if not isinstance(node, dict):
                continue
            class_type = node.get("class_type")
            if not class_type:
                continue
            spec = info.get(class_type)
            if spec is None:
                if class_type in overrides:
                    packs.add(overrides[class_type])
                else:
                    unknown.add(class_type)
                continue
            module = str(spec.get("python_module") or "")
            if module.startswith("custom_nodes."):
                packs.add(module.split(".", 1)[1])
    return packs, unknown


def catalog_entries(catalog: List[Dict[str, Any]], wanted: Set[str]
                    ) -> tuple[List[Dict[str, Any]], List[str]]:
    """Catalog rows for the wanted packs, copied verbatim, plus what is missing.

    Verbatim matters: the URL, folder and note in the catalog are what a working
    install was built from. Retyping them is how a a repository URL quietly
    becomes a fork nobody meant to ship.
    """
    by_folder = {str(e.get("folder", "")).lower(): e for e in catalog}
    out: List[Dict[str, Any]] = []
    missing: List[str] = []
    for name in sorted(wanted, key=str.lower):
        entry = by_folder.get(name.lower())
        if entry is None:
            missing.append(name)
        else:
            # `core` was v3's way of saying a pack is essential. Modules say
            # that now, and they say it from the workflows, so carrying the
            # flag forward would leave two answers to one question - which is
            # how v3's ended up marking four packs no workflow uses.
            out.append({k: v for k, v in entry.items() if k != "core"})
    return out, missing


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--modules", action="store_true",
                    help="also rewrite each module's custom_nodes")
    ap.add_argument("--check", action="store_true",
                    help="exit non-zero if the written files are out of date")
    ap.add_argument("--comfy", default=None)
    args = ap.parse_args()

    info = object_info(args.comfy)
    catalog = json.loads(CATALOG.read_text(encoding="utf-8-sig"))
    graphs = sorted(WORKFLOWS.rglob("*.json"))

    needed, unknown = packs_for(graphs, info)
    needed |= set(ALWAYS)
    entries, missing = catalog_entries(catalog, needed)

    print(f"  {len(graphs)} workflow graph(s) -> {len(entries)} node pack(s)")
    for e in entries:
        print(f"     {e['folder']}")
    if unknown:
        # Not a warning. An unattributed node type means the pack providing it
        # never reaches nodes.json, so the workflow ships and fails on somebody
        # else's machine with "node not found" - the exact class of fault this
        # script exists to make impossible.
        print(f"  [ERROR] {len(unknown)} node type(s) cannot be attributed to a pack:")
        for t in sorted(unknown):
            print(f"     {t}")
        print("          Either read object_info from a ComfyUI that has them")
        print("          (--comfy http://127.0.0.1:8199), or name the pack in")
        print("          config/node_overrides.json.")
        sys.exit(1)
    if missing:
        print(f"  [ERROR] not in node_catalog.json: {', '.join(missing)}")
        print("          Add the pack and its git URL there, then run again.")
        sys.exit(1)

    text = json.dumps(entries, indent=2, ensure_ascii=False) + "\n"
    if args.check:
        current = NODES.read_text(encoding="utf-8-sig") if NODES.exists() else ""
        if current.strip() != text.strip():
            sys.exit("config/nodes.json is out of date - run require_nodes.py")
        print("  nodes.json is current")
    else:
        NODES.write_text(text, encoding="utf-8")
        print(f"  wrote {NODES.relative_to(ROOT)}")

    if not args.modules or not MODULES.exists():
        return

    # Per module, the same computation over that module's own workflows. This
    # is what stops a booster's dependency from settling into core: a module
    # only ever lists what its own graphs reach.
    modules = json.loads(MODULES.read_text(encoding="utf-8-sig"))
    rows = modules if isinstance(modules, list) else modules.get("modules", [])
    changed = 0
    for mod in rows:
        files: List[Path] = []
        for entry in mod.get("workflows") or []:
            target = WORKFLOWS / entry
            # A module may name a single graph or the folder its graphs live in.
            files.extend(sorted(target.rglob("*.json")) if target.is_dir()
                         else ([target] if target.is_file() else []))
        own, _ = packs_for(files, info)
        if mod.get("pack") == "core":
            own |= set(ALWAYS)
        new = sorted(own, key=str.lower)
        if mod.get("custom_nodes") != new:
            mod["custom_nodes"] = new
            changed += 1
        print(f"     {mod.get('id'):<28} {len(files)} wf -> {len(new)} pack(s)")
    if changed and not args.check:
        MODULES.write_text(json.dumps(modules, indent=2, ensure_ascii=False) + "\n",
                           encoding="utf-8")
        print(f"  updated custom_nodes on {changed} module(s)")
    elif changed:
        sys.exit(f"{changed} module(s) have stale custom_nodes")


if __name__ == "__main__":
    main()
