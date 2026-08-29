"""Turn a control's value into the shape one node wants to receive it in.

Almost every input takes the value as it stands: the mapping names a node and
an input, and `workflow_service` writes it there. A few do not, and this is for
those.

The case that forced it is ComfyUI-Pixaroma. Its nodes draw their widgets in
JavaScript rather than declaring them in Python, and the browser packs them
into a single hidden JSON string at submit time - the prompt text arrives as
`PromptState`, the chosen sound file as `LoadAudioState`. Nothing about the
node's Python signature says so; it is written in a comment above INPUT_TYPES.

Without this, four MiniMax workflows could be converted and rendered but never
run: the controls existed and had nowhere to put their values.

A mapping entry opts in by naming an encoder:

    "prompt": { "node_id": "272", "input_key": "PromptState",
                "label": "Prompt", "encode": "pixaroma_prompt" }

Keep this small. An encoder here is a statement that a node's own interface is
unusual, not a place to reshape values that fit perfectly well already.
"""

import json
import logging
from typing import Any, Callable, Dict

logger = logging.getLogger(__name__)


def pixaroma_prompt(value: Any) -> str:
    """The prompt, as Pixaroma's browser code would submit it.

    `order` and `sep` decide how a wired-in prompt is joined with the typed
    one. FEDDA drives the typed one and wires nothing, so "mine" is both the
    accurate answer and the only one that changes nothing.
    """
    return json.dumps({"text": str(value or ""), "order": "mine", "sep": ", "})


def pixaroma_audio(value: Any) -> str:
    """The chosen sound file and the piece of it to use.

    The control hands over `{file, start, end}` because end is what a person
    picks off a timeline; the node wants a length, so the conversion happens
    here rather than in the browser - one place, and the arithmetic is visible
    next to the reason for it.

    `whenUnwired` decides what an unconnected `seconds` input means to the
    node: "whole" ignores length entirely, so a trim only takes effect when it
    is switched to "length". Sending a start and a length while leaving it on
    "whole" renders the entire file and looks like the trim was ignored.

    A bare string still works - a file with no trim is the whole file.
    """
    if isinstance(value, dict):
        name = str(value.get("file") or "")
        start = float(value.get("start") or 0)
        end = float(value.get("end") or 0)
        length = max(end - start, 0.0)
        state = {"file": name, "start": start}
        if length > 0:
            state["length"] = length
            state["whenUnwired"] = "length"
        return json.dumps(state)
    return json.dumps({"file": str(value or "")})


ENCODERS: Dict[str, Callable[[Any], Any]] = {
    "pixaroma_prompt": pixaroma_prompt,
    "pixaroma_audio": pixaroma_audio,
}


def apply(mapping: Dict[str, Any], params: Dict[str, Any]) -> Dict[str, Any]:
    """Encode any param whose mapping entry asks for it. Returns a new dict.

    A copy rather than in-place: the caller's params are also what gets logged
    and echoed back, and an encoded blob is not what the user typed.
    """
    inputs = mapping.get("inputs") or {}
    out = dict(params)
    for key, spec in inputs.items():
        if not isinstance(spec, dict):
            continue
        name = spec.get("encode")
        if not name or key not in out:
            continue
        encoder = ENCODERS.get(str(name))
        if encoder is None:
            # Named but unknown. Loud, because the alternative is a control that
            # silently does nothing - which is the failure this module exists
            # to end.
            logger.warning("mapping asks for unknown encoder %r on %r", name, key)
            continue
        out[key] = encoder(out[key])
    return out
