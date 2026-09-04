"""Extra modules loaded from folders outside the repository.

The app ships one set of workflows and one model list, both tracked in git. A
pack is a second set, kept somewhere else entirely and pointed at from
`config/runtime_settings.json`, which is itself untracked.

That location matters more than it looks. `update_code.ps1` runs

    git reset --hard origin/main
    git clean -fd

so anything inside the tree that git does not know about is removed on the next
update. A pack lives outside the tree, where neither command can reach it, and
survives every update without needing a gitignore entry - so nothing in the
published repository records that packs exist on any particular machine.

A pack folder looks like the app's own config, because there is no reason for
it to look different:

    <pack>/
        modules.json        one or more module declarations - the cards
        workflow_api.json   mapping entries, in the same shape as config/
        workflows/...       the graphs those entries name
        models.json         model specs, in model_downloader's shape

Every part is optional. A pack that only adds a model source is a models.json
and nothing else.

Nothing here validates content or opinions about it. A pack is data the owner
of the machine chose to point at, read the same way the app reads its own.
"""

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List

logger = logging.getLogger(__name__)


def pack_roots(settings: Dict[str, Any]) -> List[Path]:
    """The pack folders this machine is configured with, that exist.

    A path that has gone away is skipped rather than raised: a pack on a drive
    that is not plugged in should quietly not be there, not stop the app from
    starting.
    """
    raw = settings.get("pack_paths")
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, (list, tuple)):
        return []
    roots: List[Path] = []
    seen = set()
    for item in raw:
        text = str(item or "").strip()
        if not text:
            continue
        key = text.rstrip("/\\").lower()
        if key in seen:
            continue
        seen.add(key)
        path = Path(text)
        if path.is_dir():
            roots.append(path)
        else:
            logger.info("pack folder is not there, skipping: %s", text)
    return roots


def _read_json(path: Path) -> Any:
    """One file, or None. A broken pack must not take the app down with it."""
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        # Named, because a pack that silently contributes nothing is the same
        # failure this codebase has spent a lot of effort ending elsewhere.
        logger.warning("pack file %s could not be read: %s", path, exc)
        return None


def modules(roots: List[Path]) -> List[Dict[str, Any]]:
    """Module declarations from every pack, in the order the packs are listed."""
    out: List[Dict[str, Any]] = []
    for root in roots:
        data = _read_json(root / "modules.json")
        rows = data if isinstance(data, list) else (data or {}).get("modules")
        if not isinstance(rows, list):
            continue
        for row in rows:
            if isinstance(row, dict) and row.get("id"):
                out.append(row)
    return out


def areas(roots: List[Path]) -> List[Dict[str, Any]]:
    """Top-level cards a pack brings with it.

    Declared in the pack's modules.json beside the modules:

        {"areas": [{"id": "studio", "label": "Studio", "description": "..."}],
         "modules": [{"id": "...", "area": "studio", ...}]}

    Optional. A pack whose modules sit under image or video declares none and
    its cards appear beside the app's own.
    """
    out: List[Dict[str, Any]] = []
    seen = set()
    for root in roots:
        data = _read_json(root / "modules.json")
        rows = (data or {}).get("areas") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            continue
        for row in rows:
            if isinstance(row, dict) and row.get("id") and row["id"] not in seen:
                seen.add(row["id"])
                out.append(row)
    return out


def mapping(roots: List[Path]) -> Dict[str, Any]:
    """Workflow mapping entries from every pack.

    `filename` is left exactly as written. It is resolved against the pack's
    own workflows folder by workflow_dirs() below, which is what keeps a pack
    mapping identical in shape to the app's own - a pack author writes
    "family/name.json" and does not think about where the pack is installed.
    """
    out: Dict[str, Any] = {}
    for root in roots:
        data = _read_json(root / "workflow_api.json")
        if not isinstance(data, dict):
            continue
        for key, spec in data.items():
            if not isinstance(spec, dict):
                continue
            if key in out:
                logger.warning("two packs both define workflow %r; keeping the "
                               "first", key)
                continue
            out[key] = spec
    return out


def workflow_dirs(roots: List[Path]) -> List[Path]:
    """Where to look for a pack's graphs, in pack order."""
    return [root / "workflows" for root in roots
            if (root / "workflows").is_dir()]


def model_specs(roots: List[Path]) -> Dict[str, Dict[str, Any]]:
    """Model sources a pack brings with it.

    Same shape as model_downloader's own tables. A pack has to carry these:
    a workflow whose models nothing knows how to fetch is a red page on every
    machine but the one it was built on.

    relative_dir arrives as a string in JSON and is turned into a Path here,
    because that is what the downloader compares and joins with.
    """
    out: Dict[str, Dict[str, Any]] = {}
    for root in roots:
        data = _read_json(root / "models.json")
        if not isinstance(data, dict):
            continue
        for name, spec in data.items():
            if not isinstance(spec, dict) or name in out:
                continue
            spec = dict(spec)
            if isinstance(spec.get("relative_dir"), str):
                spec["relative_dir"] = Path(spec["relative_dir"])
            if isinstance(spec.get("root_relative_path"), str):
                spec["root_relative_path"] = Path(spec["root_relative_path"])
            out[name] = spec
    return out


def summary(roots: List[Path]) -> str:
    """One line for the startup log, so a pack that loaded is visible."""
    if not roots:
        return "no packs configured"
    return "%d pack(s): %s" % (
        len(roots), ", ".join(os.path.basename(str(r).rstrip("/\\")) for r in roots))
