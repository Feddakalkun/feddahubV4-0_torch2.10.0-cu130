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

_VIDEO_NODES = re.compile(
    r"videocombine|savevideo|savewebm|savewebp|createvideo|vhs_", re.I)
_VIDEO_INPUTS = ("length", "frame_rate", "duration_frames", "num_frames")


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


def _graph_value(graph: Dict[str, Any], node_id: str, input_key: str) -> Any:
    """The literal this input currently holds, or None if it is wired.

    A wired input is stored as `["12", 0]` - a reference to another node's
    output, not a value. Handing that to a control as its default would put a
    list where a number belongs.
    """
    node = graph.get(node_id) or {}
    value = (node.get("inputs") or {}).get(input_key)
    return None if isinstance(value, list) else value


def _number_bounds(kind: str, opts: Dict[str, Any]) -> Dict[str, Any]:
    """Range and step for a numeric control, as the node declares them."""
    out: Dict[str, Any] = {}
    for src, dst in (("min", "min"), ("max", "max"), ("step", "step")):
        if src in opts and isinstance(opts[src], (int, float)):
            out[dst] = opts[src]
    if "step" not in out:
        out["step"] = 1 if kind == "INT" else 0.01
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
        if override_choices is not None:
            field["options"] = override_choices
            values = [c.get("value") if isinstance(c, dict) else c
                      for c in override_choices]
            field["default"] = value if value in values else (values[0] if values else None)
        else:
            field["default"] = value
        if override == "number":
            field.update(_number_bounds(kind or "INT", opts))
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
        field.update(_number_bounds(kind or ("INT" if isinstance(value, int) else "FLOAT"), opts))
        # A seed is a number the user mostly wants re-rolled rather than typed,
        # so the renderer puts a dice next to it. Same control, different affordance.
        if key == "seed" or key.endswith("_seed"):
            field["role"] = "seed"
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
    }
