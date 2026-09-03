"""What models a workflow needs, and whether this machine already has them.

Derived from the graph, not from a list. A `HuggingFaceDownloader` node carries
a `download_links` widget - one `URL folder [filename]` per line - so the
workflow states its own model requirements, and adopting a new workflow does not
mean maintaining a second inventory of what it needs. Same principle as
`require_nodes.py` deriving the node list.

Carried from v3's server.py, where it was spread across five helpers among 7800
lines. The behaviour is v3's; the shape is not, so this can be tested and so the
endpoints that use it stay short.
"""

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

logger = logging.getLogger(__name__)

# A model is present when it is big enough to be one. A few hundred bytes of
# HTML error page is not a model, and counting one as present is how a download
# gets skipped and the run fails later on a corrupt file.
_MIN_MODEL_BYTES = 10_000

# ComfyUI's own aliases. A diffusion model may sit under `unet` or under
# `diffusion_models`, a text encoder under `clip` or `text_encoders`, and a
# library organised either way still has the file.
_MODEL_FOLDER_ALIASES = {
    "diffusion_models": ("diffusion_models", "unet"),
    "unet": ("unet", "diffusion_models"),
    "text_encoders": ("text_encoders", "clip"),
    "clip": ("clip", "text_encoders"),
}

# HEAD costs a round trip and a model's size does not change. Keyed by URL.
_remote_size_cache: Dict[str, int] = {}

# Partial-download suffixes, so a transfer in flight reports its real progress
# rather than sitting at zero until the moment it finishes.
_PARTIAL_SUFFIXES = (".incomplete", ".part", ".tmp", ".fedda_tmp")


def extra_paths(value: Any) -> List[str]:
    """The configured extra model folders, however they were stored.

    One folder was never enough for anyone with a collection: models end up on
    whichever drive had room at the time. The setting holds a list now, and a
    plain string is still read as a list of one so an install written before
    this keeps working without a migration step.

    Blank entries are dropped and duplicates collapse, because a path listed
    twice makes ComfyUI resolve every model through two identical roots.
    """
    if isinstance(value, str):
        items = [value]
    elif isinstance(value, (list, tuple)):
        items = list(value)
    else:
        items = []
    out: List[str] = []
    seen = set()
    for item in items:
        text = str(item or "").strip()
        if not text:
            continue
        key = text.rstrip("\/").lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


def model_search_roots(root_dir: Path, extra_models_path: Any = "") -> List[Path]:
    """Every models directory ComfyUI will search, FEDDA's own first.

    ComfyUI is told about more than one root - ours, plus whatever Settings >
    Folders points at - so "is this model here?" cannot be answered by looking
    in one directory. It was, once, and pressing Generate started re-downloading
    a 20 GB UNet that was already on disk under another drive.
    """
    roots = [root_dir / "ComfyUI" / "models"]
    for extra in extra_paths(extra_models_path):
        path = Path(extra)
        if path.is_dir() and path not in roots:
            roots.append(path)
    return roots


def find_existing_model(folder: str, filename: str, root_dir: Path,
                        extra_models_path: str = "") -> Optional[Path]:
    """The file as ComfyUI would find it, or None."""
    for root in model_search_roots(root_dir, extra_models_path):
        for name in _MODEL_FOLDER_ALIASES.get(folder, (folder,)):
            candidate = root / name / filename
            try:
                if candidate.is_file() and candidate.stat().st_size > _MIN_MODEL_BYTES:
                    return candidate
            except OSError:
                continue
    return None


def _filename_from_download_line(parts: List[str]) -> str:
    """The third column when the line gives one, otherwise the URL's own name."""
    if len(parts) >= 3 and parts[2].strip():
        return Path(parts[2].strip()).name
    url_path = parts[0].split("?", 1)[0].rstrip("/")
    return Path(url_path).name


def parse_download_links(workflow: Dict[str, Any], root_dir: Path,
                         extra_models_path: str = "") -> List[Dict[str, Any]]:
    """Every model this graph declares, with where it would go and whether it is
    already somewhere ComfyUI can see."""
    files: List[Dict[str, Any]] = []
    seen = set()

    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        raw_links = str((node.get("inputs") or {}).get("download_links") or "").strip()
        if not raw_links:
            continue

        title = ((node.get("_meta") or {}).get("title")
                 or node.get("class_type") or str(node_id))
        for line in raw_links.splitlines():
            clean = line.strip()
            if not clean or clean.startswith("#"):
                continue
            parts = clean.split()
            if len(parts) < 2:
                continue
            url = parts[0].strip()
            folder = parts[1].strip().replace("\\", "/").strip("/")
            filename = _filename_from_download_line(parts)
            if not url.startswith(("http://", "https://")) or not folder or not filename:
                continue

            key = (folder.lower(), filename.lower())
            if key in seen:
                continue
            seen.add(key)

            found = find_existing_model(folder, filename, root_dir, extra_models_path)
            files.append({
                "node_id": str(node_id),
                "node_title": str(title),
                "url": url,
                "folder": folder,
                "filename": filename,
                # Where it would be downloaded to - always FEDDA's own tree.
                "path": str(root_dir / "ComfyUI" / "models" / folder / filename),
                # Where it actually is, which may be the user's own library.
                "exists": found is not None,
                "found_at": str(found) if found else None,
                "size_bytes": found.stat().st_size if found else 0,
            })
    return files


def remote_content_length(url: str, hf_token: str = "") -> int:
    """How big the file is, according to the server. 0 when it will not say."""
    if url in _remote_size_cache:
        return _remote_size_cache[url]
    total = 0
    try:
        headers = {}
        if hf_token and "huggingface.co" in url:
            headers["Authorization"] = f"Bearer {hf_token}"
        # allow_redirects so Hugging Face's CDN 302 is followed to the real object
        response = requests.head(url, headers=headers, allow_redirects=True, timeout=15)
        total = int(response.headers.get("content-length", 0) or 0)
    except (requests.RequestException, ValueError):
        total = 0
    if total > 0:
        _remote_size_cache[url] = total
    return total


def live_progress(files: List[Dict[str, Any]], hf_token: str = "",
                  status_of: Optional[Any] = None) -> List[Dict[str, Any]]:
    """Bytes on disk against bytes expected, for a progress bar.

    Partial files count. A download manager writing `model.safetensors.part`
    leaves the final name absent until it finishes, so reading only the final
    name shows nothing happening for the entire transfer - which for a 20 GB
    UNet is twenty minutes of a bar that looks stuck.
    """
    out: List[Dict[str, Any]] = []
    for item in files:
        target = Path(item["path"])
        current = 0
        complete = False
        try:
            if target.is_file():
                size = target.stat().st_size
                current = size
                complete = size > _MIN_MODEL_BYTES
        except OSError:
            pass
        for suffix in _PARTIAL_SUFFIXES:
            try:
                partial = Path(str(target) + suffix)
                if partial.is_file():
                    current = max(current, partial.stat().st_size)
            except OSError:
                pass

        # A file already in the user's own library is complete at its own size,
        # wherever it sits - it is never going to appear under our tree.
        if item.get("exists") and not complete:
            complete = True
            current = max(current, int(item.get("size_bytes") or 0))

        row = {
            "filename": item["filename"],
            "folder": item["folder"],
            "exists": complete,
            "currentBytes": current,
            "totalBytes": remote_content_length(str(item.get("url") or ""), hf_token),
        }

        # Why nothing is happening. Bytes alone cannot tell a download that
        # failed from one that has not started, so both drew as "Waiting..."
        # - and a gated model waits like that forever while the backend has
        # known the reason all along.
        if status_of is not None and not complete:
            state = status_of(item["filename"]) or {}
            if state.get("status") == "error" and state.get("error"):
                row["error"] = str(state["error"])
            elif state.get("status"):
                row["status"] = str(state["status"])
            # The preflight already worked out why - a pack fetches it, or
            # nothing does. Repeating that reasoning here is how the two
            # halves of one dialog end up disagreeing.
            if item.get("note"):
                row["error"] = str(item["note"])
            elif not item.get("url"):
                row["error"] = ("Nothing knows where to download this. It has no "
                                 "entry in the model list.")
        out.append(row)
    return out


# A model file, by the look of its name. ComfyUI does not mark these in
# object_info - a loader's COMBO lists filenames without saying they are
# files - so the extension is what identifies one.
_MODEL_EXTENSIONS = (".safetensors", ".pt", ".pth", ".ckpt", ".bin",
                     ".gguf", ".onnx")

# Where each loader's folder is, when the spec table does not already say.
# Only needed to know where a file *would* go; an existing one is found by
# searching every root regardless, so an unlisted loader still works.
_LOADER_FOLDERS = {
    "UNETLoader": "unet",
    "CLIPLoader": "clip",
    "DualCLIPLoader": "clip",
    "VAELoader": "vae",
    "CheckpointLoaderSimple": "checkpoints",
    "ControlNetLoader": "controlnet",
    "ModelPatchLoader": "model_patches",
    "LoadLotusModel": "unet",
    "SAMLoader": "sams",
    "UpscaleModelLoader": "upscale_models",
    "UltralyticsDetectorProvider": "ultralytics",
    "LoraLoader": "loras",
    "LoraLoaderModelOnly": "loras",
    "Power Lora Loader (rgthree)": "loras",
    "UnetLoaderGGUF": "unet",
    "DualCLIPLoaderGGUF": "clip",
}


def _named_files(node: Dict[str, Any]) -> List[Any]:
    """Every input value that could name a file, dicts unwrapped.

    rgthree's Power Lora Loader does not store a LoRA name as a string. Each
    slot is `{"on": true, "lora": "...", "strength": 0.75}`, so a plain walk
    over the input values sees a dict, skips it, and reports the graph as
    naming no LoRA at all - which is how a baked-in distill LoRA sat in four
    workflows with nothing to download it.
    """
    values: List[Any] = []
    for value in (node.get("inputs") or {}).values():
        if isinstance(value, dict):
            # An off slot is not a requirement. Downloading a LoRA the graph
            # has switched off is a gigabyte spent on nothing.
            if value.get("on") is False:
                continue
            values.extend(v for v in value.values() if isinstance(v, str))
        else:
            values.append(value)
    return values


def models_from_graph(graph: Dict[str, Any]) -> List[Dict[str, str]]:
    """Every model file the graph names, with the folder it belongs in.

    The workflow already states this in its loader nodes, so deriving it is
    the same move require_nodes.py makes for node packs: nobody keeps a
    second list in step with the first. modules.json's hand-kept array was
    wrong both ways - naming files nothing could fetch, and naming none at
    all for a workflow that needs eight.
    """
    found: Dict[str, Dict[str, str]] = {}
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type") or "")
        for value in _named_files(node):
            if not isinstance(value, str):
                continue
            if not value.lower().endswith(_MODEL_EXTENSIONS):
                continue
            # A value may carry its own subfolder - "bbox/face_yolov8m.pt" -
            # which belongs under the loader's folder, not instead of it.
            name = value.replace("\\", "/")
            base = name.rsplit("/", 1)[-1]
            sub = name.rsplit("/", 1)[0] if "/" in name else ""
            folder = _LOADER_FOLDERS.get(class_type, "")
            if sub:
                folder = "%s/%s" % (folder, sub) if folder else sub
            found.setdefault(base.lower(), {
                "filename": base, "folder": folder, "node_class": class_type})
    return list(found.values())


def find_anywhere(filename: str, root_dir: Path,
                  extra_models_path: str = "") -> Optional[Path]:
    """The file under any models root, at any depth.

    For files the spec table does not place. Slower than find_existing_model
    and only reached for those, so the walk is worth what it buys: reporting
    a model as missing when the user already has it is how a 12 GB download
    gets started for nothing.
    """
    for root in model_search_roots(root_dir, extra_models_path):
        try:
            for candidate in root.rglob(filename):
                if candidate.is_file() and candidate.stat().st_size > _MIN_MODEL_BYTES:
                    return candidate
        except OSError:
            continue
    return None


# ComfyUI's own reserve, from comfy/model_management.minimum_inference_memory():
# 0.8 GB plus 600 MB on Windows for the shared-VRAM issue. A constant - it does
# not grow with the clip.
_COMFY_RESERVE_GB = 0.8 + 0.6

# Activations, generously. ComfyUI computes these as
#   area * dtype_size * 0.01 * memory_usage_factor   (comfy/model_base.py)
# and for MiniMax H3 at 1344x768 that is 0.29 GB at 124 frames and 0.82 GB at
# 360. Under a gigabyte across the whole range, so one number covers it without
# modelling every latent format. Being half a gigabyte out here does not change
# any answer; being wrong about the weights would.
_ACTIVATION_GB = 1.0

# Loaders whose file sits in VRAM while the model runs, against those that are
# loaded, used and freed before the model is. A text encoder is the second kind,
# which is why the peak is the larger of the two rather than their sum - adding
# them said Z-Image needs 17.7 GB when it needs 13.8.
_UNET_KEYS = ("unet_name",)
_ENCODER_KEYS = ("clip_name", "clip_name1", "clip_name2")


def vram_estimate(graph: Dict[str, Any], root_dir: Path,
                  extra_models_path: str = "") -> Dict[str, Any]:
    """Roughly what this graph needs resident, in GB.

    Sizes come off disk rather than a table, so they are exact for anything
    already downloaded and the estimate simply says less when they are not.

    A text encoder pinned to the CPU is not counted: it never reaches the card.
    """
    unets: List[float] = []
    encoder = 0.0
    known = True
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") or {}
        on_cpu = str(inputs.get("device") or "") == "cpu"
        for key, value in inputs.items():
            if not isinstance(value, str) or not value:
                continue
            is_unet = key in _UNET_KEYS
            is_enc = key in _ENCODER_KEYS
            if not (is_unet or is_enc):
                continue
            name = value.replace("\\", "/").rsplit("/", 1)[-1]
            found = find_anywhere(name, root_dir, extra_models_path)
            if found is None:
                known = False
                continue
            gb = found.stat().st_size / 1024 ** 3
            if is_unet:
                unets.append(gb)
            elif not on_cpu:
                encoder += gb
    # Several UNet loaders in one graph are almost always alternatives rather
    # than a chain - Director wires both fl2va and ref2va and its own
    # pick_model() runs exactly one, chosen by the references switch. Summing
    # them said 41.5 GB for a graph that needs 21.9, which would tell someone
    # with the right card that they cannot run it.
    unet = max(unets) if unets else 0.0
    peak = max(unet, encoder) + _ACTIVATION_GB + _COMFY_RESERVE_GB
    return {"peak_gb": round(peak, 1), "unet_gb": round(unet, 1),
            "encoder_gb": round(encoder, 1), "complete": known}


def encoder_placement(graph: Dict[str, Any], root_dir: Path,
                      extra_models_path: Any = "",
                      vram_gb: float = 0.0) -> Dict[str, Any]:
    """Where this graph's text encoder should run on this particular card.

    The setting that mattered most and was hardest to guess. MiniMax carries a
    32B encoder of just under 15 GB. Forced onto the CPU it turned a three
    minute clip into thirteen; loaded onto a card that cannot hold it, it has
    to be streamed instead, which is its own kind of slow. The right answer is
    different on a 24 GB card and an 8 GB one, and nobody should have to know
    that to get a reasonable first run.

    So it is measured rather than assumed: the encoder's real size on disk
    against the card's real VRAM, with the same headroom vram_estimate uses.

    Returns the choice and a sentence saying why, because a control that moves
    on its own without explaining itself is worse than one that never moves.
    An unknown card returns nothing and the graph's own value stands.
    """
    if not vram_gb:
        return {}
    estimate = vram_estimate(graph, root_dir, extra_models_path)
    encoder = float(estimate.get("encoder_gb") or 0.0)
    if encoder <= 0:
        return {}
    needed = encoder + _ACTIVATION_GB + _COMFY_RESERVE_GB
    if needed <= vram_gb:
        return {"default": "default",
                "note": ("Your card has %.0f GB, and the text encoder needs about "
                         "%.1f GB. Running it on the graphics card, which is "
                         "several times faster than the processor."
                         % (vram_gb, encoder))}
    return {"default": "cpu",
            "note": ("The text encoder needs about %.1f GB and your card has "
                     "%.0f GB, so it runs on the processor instead. That is "
                     "slower, but it leaves the card free for the model itself."
                     % (encoder, vram_gb))}


def load_graph(path: str) -> Dict[str, Any]:
    """A workflow file as a dict, or empty when it cannot be read."""
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}
