"""Turn a ComfyUI UI workflow into the API graph FEDDA runs.

The UI format is what ComfyUI saves from the canvas: nodes with positions and a
flat `widgets_values` list, links as tuples, groups as titled rectangles. The API
format is what `/prompt` accepts: `{"id": {"class_type": ..., "inputs": {...}}}`
with every value named. This converts the first into the second so a workflow
can be adopted without asking anyone to re-export it group by group.

Two things make a naive conversion produce a graph that runs and is wrong.

**control_after_generate.** It sits in `widgets_values` right after any seed and
is not an input at all - the frontend owns it. In a real file a KSampler reads
`[24588933, 'fixed', 20, 1]`: seed, control_after_generate, steps, cfg. Line the
list up against the node's inputs and the string 'fixed' lands in `steps`.
Position is not enough; the names have to come from object_info.

**Bypass is not mute.** Mode 2 removes a node. Mode 4 passes its input through
to whatever consumed its output, by matching type. In a sample of 40 of these
files there were 426 bypassed nodes against 1069 active ones, so getting this
wrong is not a corner case.

Usage:

    python scripts/ui_to_api.py <workflow.json> [--group "QWEN REALISTIC"]
                                                [--out out.json]
                                                [--comfy http://127.0.0.1:8199]

Node signatures are cached in config/object_info.cache.json after the first run,
so later conversions work with ComfyUI shut down.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "config" / "object_info.cache.json"
# Signatures for nodes whose widgets are defined in JavaScript. object_info
# cannot report those even on an install that has the pack, so they are read
# from the pack source and committed. Merged over whatever object_info gives.
EXTRA_SIGNATURES = ROOT / "config" / "node_signatures.extra.json"

# Widgets the canvas owns. They occupy a slot in widgets_values and correspond
# to no input, so they have to be skipped while walking the list.
UI_ONLY_AFTER = {"seed", "noise_seed"}
# Named like inputs, but they are the canvas drawing itself. They keep their
# slot in widgets_values - dropping the name would shift every value after it
# - and are then left out of the submitted graph.
#
# videopreview is VHS_VideoCombine's player state, and it carries the filename
# of whatever the author last rendered. It only started appearing once
# _is_widget learned to trust `default`, so it arrives with that fix.
UI_ONLY_NAMES = {"control_after_generate", "videopreview", "audioUI", "videoUI",
                 "imageUI", "previewaudio", "preview"}

# Anything that ends a graph. An output node is a root whether or not something
# downstream reads it - that is what makes a downloader hanging off
# `easy showAnything` execute.
OUTPUT_HINTS = ("save", "preview", "showanything", "videocombine", "createvideo")


def load_object_info(comfy: Optional[str]) -> Dict[str, Any]:
    """Node signatures, from ComfyUI if it is up and from the cache if not."""
    if comfy:
        try:
            with urllib.request.urlopen(f"{comfy}/object_info", timeout=60) as r:
                info = json.loads(r.read().decode("utf-8", "ignore"))
            CACHE.parent.mkdir(exist_ok=True)
            CACHE.write_text(json.dumps(info), encoding="utf-8")
            print(f"  object_info: {len(info)} node types, cached")
            return _with_extra_signatures(info)
        except (OSError, ValueError) as exc:
            print(f"  object_info: {comfy} did not answer ({exc}); trying cache")
    if CACHE.exists():
        info = json.loads(CACHE.read_text(encoding="utf-8"))
        print(f"  object_info: {len(info)} node types, from cache")
        return _with_extra_signatures(info)
    sys.exit("No object_info. Start ComfyUI once, or pass --comfy.")


def _with_extra_signatures(info: Dict[str, Any]) -> Dict[str, Any]:
    """Add the hand-read signatures, without overwriting a real one."""
    if not EXTRA_SIGNATURES.exists():
        return info
    try:
        extra = json.loads(EXTRA_SIGNATURES.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return info
    added = 0
    for name, spec in extra.items():
        if name.startswith("_") or not isinstance(spec, dict):
            continue
        # A live signature wins. These exist to fill a gap, not to
        # override ComfyUI when it can actually answer.
        if name not in info:
            info[name] = spec
            added += 1
    if added:
        print(f"  object_info: +{added} node type(s) from node_signatures.extra.json")
    return info


# rgthree draws this node's LoRA slots in JavaScript, so ComfyUI cannot
# describe them and the ordinary widget zip cannot read them. See
# rgthree_lora_inputs().
RGTHREE_POWER_LORA = "Power Lora Loader (rgthree)"

# Canvas-only nodes that carry a signal without changing it. They have no
# API equivalent, so they are followed through and never emitted.
PASS_THROUGH = frozenset({"Reroute"})
ADD_LORA_ROW = "➕ Add Lora"


SCALARS = ("STRING", "INT", "FLOAT", "BOOLEAN", "COMBO")
DYNAMIC_COMBO = "COMFY_DYNAMICCOMBO_V3"


def _is_widget(kind: Any, opts: Dict[str, Any]) -> bool:
    """Does this input take a slot in widgets_values?

    The plain rule - uppercase type means it arrives over a link - is wrong
    twice, and both cases are in LTX 2.3:

      LTX2SamplingPreviewOverride.preview_rate is typed "FLOAT,INT". A union
      of scalars is still a scalar, and it was being read as a link.

      LTXVImgToVideoInplaceKJ.num_images is COMFY_DYNAMICCOMBO_V3 - a combo
      that also decides which further inputs exist.

    `widgetType` and `default` are what ComfyUI itself puts on a declaration it
    draws as a widget, so trust those over the type string.
    """
    if opts.get("forceInput"):
        # Drawn as a socket, so it takes no slot - and counting it shifts
        # every value after it by one. PixaromaPrompt.text_in is a STRING
        # with this set.
        return False
    if not isinstance(kind, str):
        return True                      # an inline list of choices
    if kind == DYNAMIC_COMBO:
        return True
    if opts.get("widgetType") or "default" in opts:
        return True
    if not kind.isupper():
        return True
    return all(part.strip() in SCALARS for part in kind.split(",") if part.strip())


def _declared(spec: Dict[str, Any]) -> List[Tuple[str, Any, Dict[str, Any]]]:
    """(name, kind, opts) for every declared input, required before optional."""
    out = []
    for section in ("required", "optional"):
        for name, decl in (spec.get(section) or {}).items():
            kind = decl[0] if isinstance(decl, list) and decl else decl
            opts = (decl[1] if isinstance(decl, list) and len(decl) > 1
                    and isinstance(decl[1], dict) else {})
            out.append((name, kind, opts))
    return out


def widget_names(info: Dict[str, Any], class_type: str,
                 values: Optional[List[Any]] = None) -> List[str]:
    """Input names in widget order, with the canvas-only ones interleaved.

    `values` is needed only for a dynamic combo, whose chosen key decides which
    further inputs the node has. Without it those inputs are invisible and every
    value after the combo is dropped - which is how LTX Edit Anything and Prompt
    Relay lost their guide frames and strengths.
    """
    spec = (info.get(class_type) or {}).get("input")
    if not spec:
        return []
    names: List[str] = []
    for name, kind, opts in _declared(spec):
        if not _is_widget(kind, opts):
            continue
        names.append(name)
        if name in UI_ONLY_AFTER:
            names.append("control_after_generate")
        if kind == DYNAMIC_COMBO and values is not None and len(names) <= len(values):
            chosen = str(values[len(names) - 1])
            for option in (opts.get("options") or []):
                if str(option.get("key")) != chosen:
                    continue
                for sub, subkind, subopts in _declared(option.get("inputs") or {}):
                    if _is_widget(subkind, subopts):
                        names.append(sub)
                break
    return names


def widget_defaults(info: Dict[str, Any], class_type: str) -> Dict[str, Any]:
    """Each widget's declared default, for the ones the file never stored.

    Node authors add widgets. A workflow saved before that has a
    `widgets_values` shorter than the node's input list, and the trailing
    inputs simply are not in the file - `InpaintCropImproved` here declares 24
    and the file holds 23. Zipping the two silently drops the tail, and the
    graph is then rejected for a missing required input. The default is what
    the canvas itself would have shown, so filling from it reproduces the node
    as it was on screen.
    """
    spec = info.get(class_type)
    if not spec:
        return {}
    out: Dict[str, Any] = {}
    for section in ("required", "optional"):
        for name, decl in (spec.get("input", {}).get(section) or {}).items():
            kind = decl[0] if isinstance(decl, list) and decl else decl
            opts = decl[1] if isinstance(decl, list) and len(decl) > 1 else None
            choices = opts.get("options") if isinstance(opts, dict) else None
            if isinstance(opts, dict) and "default" in opts:
                out[name] = opts["default"]
            elif isinstance(kind, list) and kind:
                out[name] = kind[0]      # a combo defaults to its first choice
            elif isinstance(choices, list) and choices:
                # A combo declared the new way carries its list under "options"
                # and often no "default" at all; the first option is what the
                # canvas shows. SaveVideo.codec is one, and a graph saved before
                # that widget existed reached ComfyUI without it - "SaveVideo
                # .execute() missing 1 required positional argument: codec",
                # raised after the whole clip had finished rendering.
                first = choices[0]
                out[name] = first.get("key") if isinstance(first, dict) else first
    return out


def in_group(node: Dict[str, Any], bounding: List[float]) -> bool:
    """Group membership is geometric: the canvas records a rectangle, not a list."""
    pos = node.get("pos") or [0, 0]
    x, y, w, h = bounding[:4]
    return x <= pos[0] <= x + w and y <= pos[1] <= y + h


def inline_subgraphs(ui: Dict[str, Any]) -> int:
    """Replace each subgraph instance with the nodes inside it.

    ComfyUI stores a subgraph as a node whose `type` is a UUID, with the real
    nodes under `definitions.subgraphs`. `/prompt` has never heard of that UUID,
    so a graph containing one is rejected outright - and eight of the workflows
    here use them, `FLUX 2 KLEIN` and `LTX 2.5` among them.

    The boundary is two pseudo-nodes: `-10` carries values in, `-20` carries the
    result out, and their slots line up with the instance's own ports. So an
    internal link from `-10` slot 2 means "whatever the instance's third input
    is fed by out here", and the flattening is a rewrite of those two ends.

    Inlined nodes take the instance's position so group membership, which is
    geometric, still puts them where the subgraph sat. Returns how many
    instances were expanded; runs until none are left, so a subgraph nested in
    a subgraph unfolds too.
    """
    defs = {str(s.get("id")): s for s in
            (ui.get("definitions") or {}).get("subgraphs") or []}
    if not defs:
        return 0

    nodes: List[Dict[str, Any]] = ui["nodes"]
    links: List[List[Any]] = [list(l) for l in ui.get("links", [])
                              if isinstance(l, list) and len(l) >= 6]
    expanded = 0

    while True:
        inst = next((n for n in nodes if str(n.get("type")) in defs), None)
        if inst is None:
            break
        sub = defs[str(inst.get("type"))]
        next_node = max([int(n["id"]) for n in nodes] +
                        [int(n["id"]) for n in sub.get("nodes", [])]) + 1
        next_link = max([int(l[0]) for l in links] +
                        [int(l["id"]) for l in sub.get("links", [])]) + 1
        in_id = (sub.get("inputNode") or {}).get("id", -10)
        out_id = (sub.get("outputNode") or {}).get("id", -20)

        remap = {int(n["id"]): next_node + i
                 for i, n in enumerate(sub.get("nodes", []))}
        inst_mode = inst.get("mode", 0)

        inner: Dict[int, Dict[str, Any]] = {}
        for n in sub.get("nodes", []):
            copy = json.loads(json.dumps(n))
            copy["id"] = remap[int(n["id"])]
            copy["pos"] = list(inst.get("pos") or [0, 0])
            if inst_mode in (2, 4):
                copy["mode"] = inst_mode      # the instance's switch wins
            for slot in copy.get("inputs") or []:
                slot["link"] = None           # rewired below
            inner[copy["id"]] = copy

        # What feeds each of the instance's own input slots, in the outer graph.
        outer_src: Dict[int, Optional[Tuple[int, int]]] = {}
        for slot, port in enumerate(inst.get("inputs") or []):
            link_id = port.get("link")
            src = next((l for l in links if int(l[0]) == link_id), None)
            outer_src[slot] = (int(src[1]), int(src[2])) if src else None

        out_src: Dict[int, Tuple[int, int]] = {}
        for l in sub.get("links", []):
            origin, o_slot = int(l["origin_id"]), int(l["origin_slot"])
            target, t_slot = int(l["target_id"]), int(l["target_slot"])
            if target == out_id:
                out_src[t_slot] = (remap[origin], o_slot)
                continue
            if origin == in_id:
                feed = outer_src.get(o_slot)
                if feed is None:
                    continue                  # that port was left unconnected
                origin, o_slot = feed
            else:
                origin = remap[origin]
            new_id, next_link = next_link, next_link + 1
            links.append([new_id, origin, o_slot, remap[target], t_slot,
                          l.get("type", "*")])
            ports = inner[remap[target]].get("inputs") or []
            if t_slot < len(ports):
                ports[t_slot]["link"] = new_id

        # Everything downstream now reads from inside the subgraph instead.
        for l in links:
            if int(l[1]) == int(inst["id"]):
                feed = out_src.get(int(l[2]))
                if feed:
                    l[1], l[2] = feed

        nodes[:] = [n for n in nodes if int(n["id"]) != int(inst["id"])]
        nodes.extend(inner.values())
        expanded += 1

    ui["links"] = links
    return expanded


def build(ui: Dict[str, Any], info: Dict[str, Any],
          group: Optional[str] = None,
          activate: bool = False) -> Dict[str, Any]:
    nodes = {int(n["id"]): n for n in ui.get("nodes", [])}
    links: Dict[int, Tuple[int, int, int, int, str]] = {}
    for l in ui.get("links", []):
        if isinstance(l, list) and len(l) >= 6:
            links[int(l[0])] = (int(l[1]), int(l[2]), int(l[3]), int(l[4]), str(l[5]))

    keep = set(nodes)
    if group:
        box = next((g["bounding"] for g in ui.get("groups", [])
                    if str(g.get("title", "")).strip().lower() == group.strip().lower()), None)
        if not box:
            have = ", ".join(str(g.get("title")) for g in ui.get("groups", []))
            sys.exit(f"No group named {group!r}. Groups here: {have}")
        keep = {i for i, n in nodes.items() if in_group(n, box)}

    def muted(node: Dict[str, Any]) -> bool:
        """Mode 2, unless we were asked to switch the branch back on.

        A workflow with an rgthree group muter stores every branch but one as
        mode 2, so the file records a switch position, not a broken graph. Six
        of the seven groups in a file like `Z IMAGE 6` are muted the moment it
        is saved. Reading that literally yields one convertible group; lifting
        it yields all seven, which is what the muter exists to let you do.

        Bypass is deliberately not lifted. Mode 4 is a statement about how the
        branch is wired - a LoRA loader passed through, say - and it still
        holds when the branch runs.
        """
        return node.get("mode") == 2 and not activate

    def source_of(node_id: int, slot: int) -> Optional[List[Any]]:
        """Where a node's input comes from, seeing through bypassed nodes.

        A bypassed node is not absent - it forwards. Dropping it instead of
        following through is how a chain silently loses a link.
        """
        node = nodes.get(node_id)
        if not node:
            return None
        inputs = node.get("inputs") or []
        if slot >= len(inputs):
            return None
        link_id = inputs[slot].get("link")
        if link_id is None:
            return None
        link = links.get(int(link_id))
        if not link:
            return None
        from_id, from_slot = link[0], link[1]
        upstream = nodes.get(from_id)
        if upstream is None or muted(upstream):
            return None

        # Group membership decides what gets *submitted*, not what may be
        # followed through. A bypassed node is never submitted - it forwards -
        # so where it happens to sit on the canvas says nothing about whether
        # the link through it is real.
        #
        # This was the wrong way round, and FLUX Krea gguf is what showed it:
        # its two CR Conditioning Mixers take their conditioning through three
        # bypassed StyleModelApplySimple nodes parked well outside the group
        # box. The links were dropped before the forwarding below could run,
        # the mixers converted with no inputs at all, and ComfyUI refused the
        # graph with "Required input is missing: conditioning_1".
        #
        # The node the chain finally lands on still has to be in the group.
        if upstream.get("mode") != 4 and from_id not in keep:
            return None
        if str(upstream.get("type")) == "PrimitiveNode":
            # A canvas-only node that exists to hand one widget its value. The
            # API has no equivalent, so the value goes straight into the input
            # it was feeding; left as a link it is an unknown node type.
            vals = upstream.get("widgets_values") or []
            return {"literal": vals[0]} if vals else None
        if str(upstream.get("type")) == "Reroute":
            # A wire with a dot on it. The canvas draws one to keep a long
            # link tidy; the API format has no such node, and emitting it
            # gets the prompt refused with "Reroute not found". It has
            # exactly one input, so follow straight through - the same
            # move as a bypassed node, for the same reason.
            return source_of(from_id, 0)
        if upstream.get("mode") == 4:
            wanted = inputs[slot].get("type")
            for i, inp in enumerate(upstream.get("inputs") or []):
                if inp.get("type") == wanted:
                    return source_of(from_id, i)
            return None
        return [str(from_id), from_slot]

    roots = [i for i, n in nodes.items()
             if i in keep and not muted(n) and n.get("mode") != 4
             and any(h in str(n.get("type", "")).lower() for h in OUTPUT_HINTS)]
    if not roots:
        # Say which candidates were rejected and why. A group whose SaveImage is
        # muted is the normal case - the file was saved with another branch live
        # - and "no output node" alone sends you looking for a bug instead.
        near = [(i, n) for i, n in nodes.items()
                if any(h in str(n.get("type", "")).lower() for h in OUTPUT_HINTS)]
        for i, n in sorted(near):
            why = "muted" if n.get("mode") == 2 else (
                "bypassed" if n.get("mode") == 4 else
                "outside the group" if i not in keep else "?")
            print(f"  {n.get('type')} #{i}: {why}")
        sys.exit("No active output node found - nothing to build a graph from.")

    reached: set = set()

    def walk(node_id: int) -> None:
        if node_id in reached or node_id not in keep:
            return
        node = nodes.get(node_id)
        if not node or muted(node):
            return
        reached.add(node_id)
        for slot in range(len(node.get("inputs") or [])):
            src = source_of(node_id, slot)
            if src and not isinstance(src, dict):
                walk(int(src[0]))

    for r in roots:
        walk(r)

    def rgthree_lora_inputs(values: List[Any]) -> Dict[str, Any]:
        """The Power Lora Loader's slots, which object_info does not declare.

        rgthree builds `lora_1..N` in JavaScript, so its Python signature is
        just `model` and `clip` - both links. widget_names() therefore returns
        nothing for this node and the positional zip below dropped every slot
        on the floor. Silently: the graph converted, ran, and produced worse
        pictures, because a distill LoRA that makes 8-step sampling coherent
        was simply not there. That is how MiniMax H3 arrived in v4 without its
        4-step turbo LoRA, and 43 of the source workflows have the same node.

        The canvas always writes the same shape:

            [null, {"type": "PowerLoraLoaderHeaderWidget"},
             {"on": .., "lora": .., "strength": ..}, ..., null, ""]

        `on: false` slots are kept as they are. They are the menu the user
        picks from in the UI, and dropping them would empty the picker; the
        model preflight already skips them so nothing downloads a LoRA the
        graph has switched off.
        """
        got: Dict[str, Any] = {}
        slot = 0
        for value in values:
            if isinstance(value, dict) and "lora" in value:
                slot += 1
                got["lora_%d" % slot] = value
            elif isinstance(value, dict) and value.get("type"):
                got[str(value["type"])] = value
        # The trailing empty string is the "add" row. rgthree writes it, and a
        # graph that matches what the canvas saves is one you can still open.
        got[ADD_LORA_ROW] = ""
        return got

    out: Dict[str, Any] = {}
    unknown: List[str] = []
    filled: List[str] = []
    dropped: List[str] = []
    for node_id in sorted(reached):
        node = nodes[node_id]
        if node.get("mode") == 4 or str(node.get("type")) in PASS_THROUGH:
            continue                       # forwarded, never submitted
        class_type = str(node.get("type", ""))
        if class_type not in info:
            unknown.append(class_type)
        values = node.get("widgets_values")
        names = widget_names(info, class_type,
                             values if isinstance(values, list) else None)
        inputs: Dict[str, Any] = {}
        if class_type == RGTHREE_POWER_LORA and isinstance(values, list):
            inputs.update(rgthree_lora_inputs(values))
        elif isinstance(values, list) and not names and any(
                v not in (None, "") for v in values):
            # The canvas saved widget values and object_info describes no
            # widgets to put them in, so every one of them is about to be
            # dropped. Two reasons, and both matter:
            #
            #   the pack is not installed - convert with it installed;
            #   the pack draws its widgets in JavaScript - it needs a
            #   case like rgthree_lora_inputs() above.
            #
            # Silence here is what cost a day: MiniMax H3 lost its distill
            # LoRA, and LTX 2.3 Prompt Relay lost an entire timeline of
            # prompts, and both graphs converted and ran without a word.
            dropped.append("%s (%d value(s))" % (class_type, len(values)))
        elif isinstance(values, list):
            defaults = widget_defaults(info, class_type)
            for idx, name in enumerate(names):
                if name in UI_ONLY_NAMES:
                    continue
                if idx < len(values):
                    inputs[name] = values[idx]
                elif name in defaults:
                    inputs[name] = defaults[name]
                    filled.append(f"{class_type}.{name}")
        elif isinstance(values, dict):
            inputs.update({k: v for k, v in values.items() if k not in UI_ONLY_NAMES})
        for slot, inp in enumerate(node.get("inputs") or []):
            src = source_of(node_id, slot)
            if isinstance(src, dict):
                inputs[str(inp.get("name"))] = src["literal"]
            elif src:
                inputs[str(inp.get("name"))] = src
        out[str(node_id)] = {"class_type": class_type, "inputs": inputs,
                             "_meta": {"title": node.get("title") or class_type}}

    if unknown:
        print(f"  [warn] {len(set(unknown))} node type(s) unknown to this ComfyUI: "
              + ", ".join(sorted(set(unknown))[:6]))
    if filled:
        print(f"  filled {len(filled)} widget(s) the file predates, from defaults: "
              + ", ".join(filled[:6]))
    if dropped:
        print("  [LOST] settings dropped - object_info declares no widgets for: "
              + ", ".join(sorted(set(dropped))))
        print("         install the pack and convert again, or add a case like"
              " rgthree_lora_inputs() if it draws its widgets in JavaScript.")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("workflow")
    ap.add_argument("--group")
    ap.add_argument("--all-groups", action="store_true",
                    help="one API graph per group, into --outdir")
    ap.add_argument("--activate", action="store_true",
                    help="treat the chosen group as switched on, whatever the "
                         "group muter left it as")
    ap.add_argument("--out")
    ap.add_argument("--outdir")
    ap.add_argument("--comfy", default="http://127.0.0.1:8199")
    args = ap.parse_args()

    ui = json.loads(Path(args.workflow).read_text(encoding="utf-8-sig"))
    if "nodes" not in ui:
        sys.exit("That is already an API graph, or not a workflow at all.")

    info = load_object_info(args.comfy)

    expanded = inline_subgraphs(ui)
    if expanded:
        print(f"  inlined {expanded} subgraph instance(s)")

    if args.all_groups:
        titles = [str(g.get("title", "")).strip() for g in ui.get("groups", [])]
        if not titles:
            sys.exit("This workflow has no groups.")
        outdir = Path(args.outdir or Path(args.workflow).with_suffix(""))
        outdir.mkdir(parents=True, exist_ok=True)
        done = 0
        for title in titles:
            print(f"\n{title}")
            try:
                graph = build(ui, info, title, activate=args.activate)
            except SystemExit as exc:
                print(f"  skipped: {exc}")
                continue
            safe = "".join(c if c.isalnum() or c in " -_+" else "_" for c in title)
            path = outdir / f"{safe}.json"
            path.write_text(json.dumps(graph, indent=2, ensure_ascii=False) + "\n",
                            encoding="utf-8")
            print(f"  {path.name}: {len(graph)} nodes")
            done += 1
        print(f"\n{done}/{len(titles)} groups written to {outdir}")
        return

    graph = build(ui, info, args.group, activate=args.activate)

    text = json.dumps(graph, indent=2, ensure_ascii=False) + "\n"
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"  wrote {args.out}: {len(graph)} nodes")
    else:
        print(text)


if __name__ == "__main__":
    main()
