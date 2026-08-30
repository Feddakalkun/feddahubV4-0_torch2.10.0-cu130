"""Turn one `workflow_api.json` entry into the fields a UI can render.

Three sources, each answering a different question:

    workflow_api.json   which node, and which of its inputs
    the workflow graph  what value that input holds right now
    object_info         what kind of control the input actually is

v3 used the first two and guessed the third. It hardcoded seven aspect ratios
(the node declares ten), hardcoded "Horizontal"/"Vertical", and never learned a
number's bounds - so every slider was a bare text box and every dropdown a
free-text field. `object_info` has all of it, and is already on disk because
`require_nodes.py` needs it; this module is what finally reads it.

Concretely, for the one workflow v4 ships: without the third source `style`
renders as a text box instead of the 26-item picker the node declares, and
`denoise` accepts 900 instead of clamping to its 0-1 range.

The control vocabulary is deliberately small. Every workflow the app will ever
adopt has to land in one of these, because the alternative is a bespoke page
per workflow, which is how v3's `pages/` reached 61 files:

    text     one line, or multiline when the node says so
    number   with min / max / step from the node
    select   a COMBO with many options
    chips    a COMBO with few, short options - the pill row v3 used for ratios
    toggle   BOOLEAN, carrying the node's own on/off labels
    file     an upload that feeds a loader node
    lora     the LoRA panel; the graph node is a placeholder, see below
"""

import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple

# A COMBO becomes a pill row rather than a dropdown when it is short enough to
# read at a glance. `direction` (2 options) and `aspect_ratio` (10 short ones)
# become chips, which is what v3's cockpit showed by hand; `styles` (26) and
# `sampler_name` (44) stay dropdowns. The rule is about what fits on a line,
# so it measures the options rather than naming the inputs.
_CHIP_MAX_OPTIONS = 10
_CHIP_MAX_LABEL = 12

# Inputs whose value the graph holds but the user should never see. v3 called
# this `_SKIP_TYPES` and its note read "advanced slots stay on the full page,
# not in chat" - it was hiding things from the chat driver because a hand-built
# page showed them instead. v4 has no second page: this IS the page. So the
# list holds only what genuinely has no control, and `object` (an opaque blob
# some nodes take) is the only member.
_SKIP_TYPES = {"object"}

# Substring hints for an upload slot. Necessary but not sufficient - see
# `_is_file_slot`, which exists because `frame_rate` contains "frame".
_FILE_HINTS = ("image", "audio", "video", "frame", "portrait", "mask")

# Neither signal is enough alone, and both had to grow for MiniMax: its four
# Pixaroma graphs save through PixaromaSaveMp4 and call their rate `fps`, so
# they were reported as making pictures - which puts a video workflow behind
# the wrong card and gives it an image preview.
_VIDEO_NODES = re.compile(
    r"videocombine|savevideo|savewebm|savewebp|createvideo|vhs_|savemp4", re.I)
_VIDEO_INPUTS = ("length", "frame_rate", "fps", "duration_frames", "num_frames")


# --------------------------------------------------------------- object_info

def load_object_info(path: Optional[str] = None) -> Dict[str, Any]:
    """Read the generated node-signature cache.

    Missing is not fatal. Every branch below degrades to v3's behaviour when
    the cache is absent, because a developer who has never started ComfyUI
    should still get a usable page rather than an exception.
    """
    if path is None:
        path = os.path.join(os.path.dirname(__file__), "..", "config",
                            "object_info.cache.json")
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


# What a seed box holds when it has not been chosen. Not a magic number the
# node knows - ComfyUI declares seeds as min 0 - but the value this app uses
# between the page and /api/generate, which replaces it before submitting.
SEED_RANDOM = -1


def input_signature(object_info: Dict[str, Any], class_type: str,
                    input_key: str) -> Tuple[str, Dict[str, Any], List[Any]]:
    """What `object_info` says one input of one node class is.

    Returns `(kind, options_dict, combo_choices)`. `kind` is ComfyUI's own type
    name - "INT", "FLOAT", "STRING", "BOOLEAN" - or "COMBO" when the node
    declares a list of choices, which is how ComfyUI expresses an enum: the
    first element of the pair is the list itself rather than a type name.
    """
    node = object_info.get(class_type) or {}
    groups = node.get("input") or {}
    for group in ("required", "optional"):
        spec = (groups.get(group) or {}).get(input_key)
        if spec is None:
            continue
        if not isinstance(spec, list) or not spec:
            return "", {}, []
        head = spec[0]
        opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
        if isinstance(head, list):
            return "COMBO", opts, head
        # ComfyUI writes an enum two ways. The old one puts the list
        # first; the new one says "COMBO" and hangs the list off options,
        # which is what KSamplerSelect.sampler_name and
        # BasicScheduler.scheduler look like now. Reading only the old
        # shape turned every one of those into a free-text box asking the
        # user to type "euler" correctly.
        if str(head).upper() == "COMBO" and isinstance(opts.get("options"), list):
            return "COMBO", opts, list(opts["options"])
        return str(head), opts, []
    return "", {}, []


# ------------------------------------------------------------------ helpers

def _is_file_slot(class_type: str, value: Any, node_known: bool) -> bool:
    """Does this input take a file the user uploads?

    The key name alone cannot say, and v3 learned it the hard way: `frame_rate`
    contains "frame" and `mask_blur_amount` contains "mask", so matching hints
    as substrings turned both into required uploads - MiniMax Text to Video
    opened asking the user to drop in a frame rate.

    A real upload slot feeds a loader node and holds a filename. Both halves
    matter: `VHS_LoadVideo` takes a video *and* a `frame_load_cap`.
    """
    if not node_known:
        return True   # nothing to consult; the old guess beats losing the slot
    if not isinstance(value, str):
        return False  # a count, a rate or a toggle is never an upload
    return "load" in class_type.lower()


def _frame_rate(graph: Dict[str, Any]) -> Optional[float]:
    """The rate this graph counts frames at, from whichever node states it.

    Read rather than assumed: LTX Prompt Relay runs at 25 and everything else
    here at 24, and showing 5.2s beside a number that means 4.96s is a worse
    kind of wrong than showing nothing.
    """
    for name in ("frame_rate", "fps"):
        for node in graph.values():
            if not isinstance(node, dict):
                continue
            value = (node.get("inputs") or {}).get(name)
            if isinstance(value, (int, float)) and 1 <= value <= 240:
                return float(value)
    return None


def _graph_value(graph: Dict[str, Any], node_id: str, input_key: str) -> Any:
    """The literal this input currently holds, or None if it is wired.

    A wired input is stored as `["12", 0]` - a reference to another node's
    output, not a value. Handing that to a control as its default would put a
    list where a number belongs.
    """
    node = graph.get(node_id) or {}
    value = (node.get("inputs") or {}).get(input_key)
    return None if isinstance(value, list) else value


# What a slider should span, per input, against what the node will accept.
#
# These are two different questions and the code answered only one. A node
# declares the range it will not reject - steps 1 to 10000, width 0 to 16384,
# and `easy int` simply says -999999 to 999999 - and driving a slider from that
# puts 25 steps, or 41 pixels, or 5000 of whatever it is, under every pixel of
# travel. The value you want is unreachable by pointing at it.
#
# So the slider spans what people actually use, and the box beside it still
# accepts anything the node does. Keys are matched exactly first, then by
# suffix, so `upscale_steps` inherits `steps`.
_UI_RANGES: Dict[str, Tuple[float, float, float]] = {
    # sampling
    "steps": (1, 60, 1),
    "cfg": (1, 15, 0.1),
    "denoise": (0, 1, 0.01),
    "guidance": (0, 10, 0.1),
    # canvas. 32 is what most of these snap to anyway.
    "width": (256, 2048, 32),
    "height": (256, 2048, 32),
    "longest_side": (512, 2048, 32),
    "size": (256, 2048, 32),
    # time
    "fps": (8, 60, 1),
    "frame_rate": (8, 60, 1),
    "length": (5, 360, 1),
    "duration_frames": (5, 360, 1),
    "start_frame": (0, 360, 1),
    "end_frame": (5, 360, 1),
    "duration_seconds": (0.5, 15, 0.1),
    "start_second": (0, 15, 0.1),
    "end_second": (0.5, 15, 0.1),
    "skip": (0, 60, 1),
    # model-specific knobs, at the ranges their own guides give
    "shift_video": (1, 30, 0.5),
    "shift_audio": (0.5, 15, 0.5),
    "img_compression": (0, 100, 1),
    "upscale_by": (1, 4, 0.05),
    "strength": (0, 2, 0.01),
    "confidence": (0.05, 0.95, 0.01),
    "control_start": (0, 1, 0.01),
    "control_end": (0, 1, 0.01),
    "divisible_by": (8, 64, 8),
}

# Frames are what the node counts and seconds are what a person means, so a
# frame field carries the rate beside it and the control shows both.
_FRAME_FIELDS = ("length", "duration_frames", "start_frame", "end_frame",
                 "frames", "frame_load_cap")


def _ui_range(key: str) -> Optional[Tuple[float, float, float]]:
    low = key.lower()
    if low in _UI_RANGES:
        return _UI_RANGES[low]
    for name, span in _UI_RANGES.items():
        if low.endswith("_" + name) or low.startswith(name + "_"):
            return span
    return None


def _number_bounds(kind: str, opts: Dict[str, Any],
                   key: str = "") -> Dict[str, Any]:
    """What the node will accept, and separately what the slider should span."""
    out: Dict[str, Any] = {}
    for src, dst in (("min", "min"), ("max", "max"), ("step", "step")):
        if src in opts and isinstance(opts[src], (int, float)):
            out[dst] = opts[src]
    if "step" not in out:
        out["step"] = 1 if kind == "INT" else 0.01

    span = _ui_range(key)
    if span:
        lo, hi, step = span
        # Never widen past what the node accepts - the box would offer a value
        # ComfyUI then refuses.
        if isinstance(out.get("min"), (int, float)):
            lo = max(lo, out["min"])
        if isinstance(out.get("max"), (int, float)):
            hi = min(hi, out["max"])
        if hi > lo:
            out.update({"ui_min": lo, "ui_max": hi, "ui_step": step})
    return out


# ------------------------------------------------------------- the descriptor

def describe_input(key: str, spec: Dict[str, Any], graph: Dict[str, Any],
                   object_info: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """One mapping entry -> one renderable field, or None to hide it."""
    declared = str(spec.get("type", "") or "")
    label = spec.get("label") or key
    if declared in _SKIP_TYPES:
        return None

    # One picker whatever the graph's slot count. The Power Lora Loader ships
    # `lora_1` and workflow_service appends the rest itself, so offering two
    # here would imply an ordering nothing guarantees.
    if declared == "loras":
        return {"key": key, "label": label, "control": "lora", "required": False}

    # The mapping may override the control outright, and sometimes must. An
    # ImpactSwitch's `select` is an INT to object_info, so the three-source rule
    # renders it as a spinner from 1 to 999999 - correct about the type and
    # useless to a person choosing between pose, depth and edges. object_info
    # cannot know that; only whoever wired the switch does.
    #
    # So: object_info decides, unless the mapping says otherwise. Overrides are
    # for when the node's type is right but too generic to act on - not for
    # re-labelling what the node already describes properly.
    override = str(spec.get("control") or "")
    # Not `choices`: input_signature binds that name below, and an INT reports
    # an empty combo list - which silently emptied this one.
    override_choices = spec.get("choices")

    node_ids = spec.get("node_ids") or ([spec["node_id"]] if spec.get("node_id") else [])
    node_id = node_ids[0] if node_ids else None
    input_key = spec.get("input_key") or key

    node_known = bool(node_id) and node_id in graph
    class_type = str((graph.get(node_id) or {}).get("class_type") or "") if node_known else ""
    value = _graph_value(graph, node_id, input_key) if node_known else None

    kind, opts, choices = input_signature(object_info, class_type, input_key)

    field: Dict[str, Any] = {
        "key": key,
        "label": label,
        "required": key in ("prompt", "positive"),
        # Kept so the frontend can drive several nodes from one control without
        # re-reading the mapping: the seed sent to the sampler must also reach
        # the FaceDetailer, or the same seed renders a different face.
        "node_ids": node_ids,
    }

    # The node's own default is the fallback when the graph has nothing, which
    # happens for an input the workflow author never touched.
    if value is None and "default" in opts:
        value = opts["default"]

    if override:
        field["control"] = override
        # Carry the presentation keys the control needs. `accept` on a file,
        # `mask` on one that wants a brush: without these an overridden file
        # control renders with no picker and no idea what it takes.
        for key_name in ("accept", "multiline", "role", "mask"):
            if key_name in spec:
                field[key_name] = spec[key_name]
        # A control that takes a file has nothing to fall back on when it is
        # empty, so it is required unless the mapping says otherwise. 
        # was missed here at first and an empty one reached ComfyUI.
        if override in ("file", "audio"):
            field["required"] = spec.get("required", True)
        if override_choices is not None:
            field["options"] = override_choices
            values = [c.get("value") if isinstance(c, dict) else c
                      for c in override_choices]
            field["default"] = value if value in values else (values[0] if values else None)
        else:
            field["default"] = value
        if override == "number":
            field.update(_number_bounds(kind or "INT", opts, key))
        return field

    # --- an upload, before anything else: a loader's filename is a STRING and
    # would otherwise render as a text box asking the user to type a path.
    if any(hint in key.lower() for hint in _FILE_HINTS) \
            and _is_file_slot(class_type, value, node_known):
        low = key.lower()
        accept = "audio" if "audio" in low else "video" if "video" in low else "image"
        field.update({"control": "file", "accept": accept, "required": True})
        # Whether this slot wants a painted mask is a fact about the workflow,
        # not about the node: LoadImage is the same class either way, and only
        # the graph's author knows the alpha channel is being read. So the
        # mapping says it.
        if spec.get("mask"):
            field["mask"] = True
        return field

    # --- the node declares its choices: this is the branch v3 never had.
    if kind == "COMBO" and choices:
        options = [c for c in choices if isinstance(c, (str, int, float))]
        short = all(len(str(o)) <= _CHIP_MAX_LABEL for o in options)
        control = "chips" if (len(options) <= _CHIP_MAX_OPTIONS and short) else "select"
        field.update({"control": control, "options": options,
                      "default": value if value in options
                      else (options[0] if options else None)})
        return field

    if kind == "BOOLEAN":
        field.update({"control": "toggle",
                      "default": bool(value) if value is not None else bool(opts.get("default")),
                      # The node names its own states - `guide_size_for` reads
                      # "bbox" / "crop_region", not "on" / "off".
                      "label_on": opts.get("label_on"),
                      "label_off": opts.get("label_off")})
        return field

    # --- numbers. The graph decides when the node did not, because most
    # numeric inputs are declared in the mapping with no `type` at all:
    # `"steps": {"node_id": "3", "input_key": "steps"}`. Falling through to the
    # text branch, whose default is "", is what once sent an empty string over
    # a working number and killed a Z-Image run on steps, cfg, seed and
    # denoise at once.
    if kind in ("INT", "FLOAT") or declared == "number" or isinstance(value, (int, float)):
        field.update({"control": "number",
                      "default": value if isinstance(value, (int, float)) else 0})
        field.update(_number_bounds(
            kind or ("INT" if isinstance(value, int) else "FLOAT"), opts, key))
        # A seed is a number the user mostly wants re-rolled rather than typed,
        # so the renderer puts a dice next to it. Same control, different
        # affordance.
        #
        # -1 means "pick one for me", and the page opens on it. A random
        # number in the box looks chosen, so nothing tells you it will
        # change; -1 says so. The node itself declares min 0 and would
        # refuse it, so /api/generate swaps it for a real value on the way
        # past and the graph never sees it.
        if key == "seed" or key.endswith("_seed"):
            field["role"] = "seed"
            field["min"] = SEED_RANDOM
        elif key.lower() in _FRAME_FIELDS:
            rate = _frame_rate(graph)
            if rate:
                field["unit"] = "frames"
                field["fps"] = rate
        return field

    # --- text last. `multiline` is the node's word, not a guess from the key.
    field.update({"control": "text",
                  "multiline": bool(opts.get("multiline")) or key in ("prompt", "negative"),
                  "default": value if isinstance(value, str) else ""})
    return field


def makes_video(spec: Dict[str, Any], graph: Dict[str, Any]) -> bool:
    """Does running this produce a clip rather than a picture?

    Neither signal is enough alone: the node classes catch every LTX and WAN
    graph but miss the ones that save through something else, and the input
    names catch those but none of the rest.
    """
    if any(k in (spec.get("inputs") or {}) for k in _VIDEO_INPUTS):
        return True
    return any(_VIDEO_NODES.search(str(n.get("class_type") or ""))
               for n in graph.values() if isinstance(n, dict))


def describe_workflow(workflow_id: str, spec: Dict[str, Any],
                      graph: Dict[str, Any],
                      object_info: Dict[str, Any]) -> Dict[str, Any]:
    """The whole form for one workflow, in the mapping's own order."""
    fields = []
    for key, field_spec in (spec.get("inputs") or {}).items():
        if not isinstance(field_spec, dict):
            continue
        entry = describe_input(key, field_spec, graph, object_info)
        if entry:
            fields.append(entry)
    return {
        "workflow_id": workflow_id,
        "name": spec.get("name", workflow_id),
        "description": spec.get("description", ""),
        "module": spec.get("module", ""),
        "makes": "video" if makes_video(spec, graph) else "image",
        "fields": fields,
        # A worked example, keyed by field. Written per model rather than
        # per workflow family, because the four models here want genuinely
        # different prompts - Z-Image a long positives-only brief, FLUX Krea
        # a photographic paragraph, MiniMax H3 a three-field document with
        # timestamped shots, LTX one flowing paragraph. An example that
        # ignores that teaches the wrong habit on 39 of the 40 pages.
        "example": spec.get("example") or {},
    }
