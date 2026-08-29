"""Every model a shipped graph names must have somewhere to come from.

The failure this catches has no error message. A graph loads a file, the
download table has no entry for it, and the model dialog draws a row with no
size, the word "Missing", and a Download button that starts nothing. Nothing is
logged; the app just looks broken. It cost a session to find once, on
minimax_h3_fl2va_pruned_int8_convrot.safetensors, which the first-frame graphs
had loaded since the day they were added.

Two ways a file is accounted for:

  url         - FEDDA downloads it.
  fetched_by  - the named node pack downloads it itself on first run, so the
                dialog says who is bringing it instead of offering a button
                that cannot act.

Anything with neither is a hole. Run this after adding a workflow, before the
graph reaches anyone.

Usage:
    python scripts/validate_models.py            # list holes, exit 0
    python scripts/validate_models.py --strict   # exit 1 if any
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from pathlib import Path  # noqa: E402

import model_links  # noqa: E402
from model_downloader import ModelDownloader  # noqa: E402


def main() -> int:
    strict = "--strict" in sys.argv
    downloader = ModelDownloader(Path(ROOT))
    workflows = sorted(Path(ROOT, "backend", "workflows").rglob("*.json"))

    holes = []
    counted = 0
    for path in workflows:
        try:
            graph = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            print("  cannot read %s: %s" % (path.name, exc))
            continue
        for item in model_links.models_from_graph(graph):
            counted += 1
            spec = downloader.spec_for(item["filename"])
            if not spec or not (spec.get("url") or spec.get("fetched_by")):
                holes.append((str(path.relative_to(Path(ROOT, "backend", "workflows"))),
                              item["filename"], item["node_class"]))

    print("%d workflows, %d model references, %d without a source"
          % (len(workflows), counted, len(holes)))

    for workflow, filename, node_class in holes:
        print("  %-34s %-52s (%s)" % (workflow, filename, node_class))

    if holes:
        print("\nAdd each to a spec table in backend/model_downloader.py - and to")
        print("all_specs, which is what the model dialog actually reads. Give it a")
        print("url if we fetch it, or fetched_by if the node pack does.")

    return 1 if (holes and strict) else 0


if __name__ == "__main__":
    sys.exit(main())
