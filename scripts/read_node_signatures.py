"""Read a node pack's signatures from its source, for packs ComfyUI cannot describe.

`object_info` is the right answer almost always, and this script is not a
replacement for it. It exists for one case: a pack whose widgets are drawn in
JavaScript rather than declared in Python. ComfyUI-Pixaroma is the example -
`PixaromaDuration` declares no inputs at all - so even a running instance with
the pack installed reports a signature with nothing in it, and the converter
has no names to zip a canvas node's positional `widgets_values` against.

Parsed, never executed. An `INPUT_TYPES` body calls into `folder_paths` and
other ComfyUI internals that do not import outside a running instance, and
running third-party code to read a dict key is a poor trade.

    python scripts/read_node_signatures.py <pack-dir> [<pack-dir> ...]
        [--out config/node_signatures.extra.json] [--only TypeA,TypeB]

Both `ui_to_api.py` and `require_nodes.py` merge the output file, and a live
signature always wins - these fill gaps rather than override.
"""

import argparse
import ast
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "config" / "node_signatures.extra.json"


def _force_input(value: ast.AST) -> bool:
    """Is this input drawn as a socket rather than a widget?

    It matters because such an input takes no slot in `widgets_values`, and
    counting one shifts every value after it by a position.
    """
    if not isinstance(value, (ast.Tuple, ast.List)) or len(value.elts) < 2:
        return False
    opts = value.elts[1]
    if not isinstance(opts, ast.Dict):
        return False
    for key, val in zip(opts.keys, opts.values):
        if (isinstance(key, ast.Constant) and key.value == "forceInput"
                and isinstance(val, ast.Constant) and val.value is True):
            return True
    return False


def _kind(value: ast.AST) -> str:
    """"INT", "STRING", "COMBO" ... or "" when the AST cannot say."""
    if isinstance(value, (ast.Tuple, ast.List)) and value.elts:
        head = value.elts[0]
        if isinstance(head, ast.Constant) and isinstance(head.value, str):
            return head.value
        if isinstance(head, (ast.List, ast.Tuple)):
            return "COMBO"
    elif isinstance(value, ast.Constant) and isinstance(value.value, str):
        return value.value
    return ""


def _entries(node: ast.AST) -> List[Tuple[str, str, bool]]:
    if not isinstance(node, ast.Dict):
        return []
    out = []
    for key, value in zip(node.keys, node.values):
        if isinstance(key, ast.Constant) and isinstance(key.value, str):
            out.append((key.value, _kind(value), _force_input(value)))
    return out


def _input_types(class_node: ast.ClassDef) -> Dict[str, List[Tuple[str, str, bool]]]:
    for item in class_node.body:
        if not isinstance(item, ast.FunctionDef) or item.name != "INPUT_TYPES":
            continue
        for stmt in ast.walk(item):
            if not isinstance(stmt, ast.Return) or not isinstance(stmt.value, ast.Dict):
                continue
            groups = {}
            for key, value in zip(stmt.value.keys, stmt.value.values):
                if isinstance(key, ast.Constant) and key.value in ("required", "optional"):
                    groups[key.value] = _entries(value)
            if groups:
                return groups
    return {}


def _class_mappings(tree: ast.Module) -> Dict[str, str]:
    """class name -> registered node type, from NODE_CLASS_MAPPINGS.

    They are not always the same. ComfyUI-MiniMaxH3-Director defines
    `MiniMaxH3Director` and registers it as `MiniMaxH3DirectorCS`, and a
    signature filed under the class name would never be found.
    """
    out = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        names = [t.id for t in node.targets if isinstance(t, ast.Name)]
        if "NODE_CLASS_MAPPINGS" not in names or not isinstance(node.value, ast.Dict):
            continue
        for key, value in zip(node.value.keys, node.value.values):
            if isinstance(key, ast.Constant) and isinstance(value, ast.Name):
                out[value.id] = key.value
    return out


def read_pack(pack: Path) -> Dict[str, Any]:
    classes: Dict[str, Dict[str, Any]] = {}
    registered: Dict[str, str] = {}
    module = "custom_nodes.%s" % pack.name

    for path in sorted(pack.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except (SyntaxError, OSError):
            continue
        registered.update(_class_mappings(tree))
        for node in tree.body:
            if not isinstance(node, ast.ClassDef):
                continue
            groups = _input_types(node)
            if not groups:
                continue
            spec: Dict[str, Any] = {"input": {}, "python_module": module}
            for group, pairs in groups.items():
                spec["input"][group] = {
                    name: ([kind, {"forceInput": True} if force else {}]
                           if kind and kind != "COMBO" else [[], {}])
                    for name, kind, force in pairs
                }
            classes[node.name] = spec

    # File under the registered type where one exists; the class name is only
    # the fallback, and it is the name the graph will not be using.
    out = {}
    for class_name, spec in classes.items():
        out[registered.get(class_name, class_name)] = spec
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("packs", nargs="+")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--only", default="",
                    help="comma-separated node types to keep")
    args = ap.parse_args()

    out_path = Path(args.out)
    existing: Dict[str, Any] = {}
    if out_path.exists():
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
        except ValueError:
            existing = {}

    keep = {k.strip() for k in args.only.split(",") if k.strip()}
    added = 0
    for raw in args.packs:
        pack = Path(raw)
        if not pack.is_dir():
            sys.exit("not a directory: %s" % pack)
        found = read_pack(pack)
        print("  %-34s %d node type(s)" % (pack.name, len(found)))
        for name, spec in found.items():
            if keep and name not in keep:
                continue
            existing[name] = spec
            added += 1

    existing["_note"] = (
        "Signatures for nodes whose widgets are defined in JavaScript, so "
        "object_info reports them as having almost no inputs even on an install "
        "that has the pack. Generated by scripts/read_node_signatures.py, which "
        "parses the pack's source rather than importing it. Merged by "
        "ui_to_api.py and require_nodes.py; a live signature always wins. "
        "Committed because object_info.cache.json is generated per machine.")

    out_path.write_text(
        json.dumps(existing, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote %s (%d node types, %d added or refreshed)"
          % (out_path, len([k for k in existing if not k.startswith("_")]), added))


if __name__ == "__main__":
    main()
