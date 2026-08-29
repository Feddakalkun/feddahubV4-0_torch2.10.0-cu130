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


def model_search_roots(root_dir: Path, extra_models_path: str = "") -> List[Path]:
    """Every models directory ComfyUI will search, FEDDA's own first.

    ComfyUI is told about more than one root - ours, plus whatever Settings >
    Folders points at - so "is this model here?" cannot be answered by looking
    in one directory. It was, once, and pressing Generate started re-downloading
    a 20 GB UNet that was already on disk under another drive.
    """
    roots = [root_dir / "ComfyUI" / "models"]
    extra = (extra_models_path or "").strip()
    if extra:
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


def load_graph(path: str) -> Dict[str, Any]:
    """A workflow file as a dict, or empty when it cannot be read."""
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}
