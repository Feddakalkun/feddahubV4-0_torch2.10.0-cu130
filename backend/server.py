"""FEDDA Hub v4 backend.

Extracted fresh rather than carried: v3's `server.py` is 7800 lines and 140
endpoints, most of them for services v4 does not ship. This is phase 1 - the
endpoints the shell and one generate page actually call.

The one genuinely new endpoint is `/api/workflow/schema/{id}`. Everything the
UI renders comes from there, so a workflow reaches the app by declaring itself
in `config/workflow_api.json` rather than by someone writing a page for it.
See `descriptor.py`.
"""

import json
import logging
import os
import random
import subprocess
import sys
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# This directory has to be on sys.path before the sibling imports below.
#
# Normally Python prepends a script's own directory and none of this is
# needed - but the app runs on the embedded distribution, whose
# python311._pth replaces sys.path outright and does not include it. So
# `import descriptor` fails at startup with ModuleNotFoundError, the backend
# never binds port 8000, and the UI loads with every module missing rather
# than with an error that names the cause.
#
# v3 carried these three lines for the same reason. Writing this file fresh
# lost them, and the in-process tests hid it by putting backend/ on the path
# themselves - so it passed everywhere except where it runs.
_backend_dir = os.path.dirname(os.path.abspath(__file__))
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

import descriptor
import encoders
import model_links
import packs
from logging_setup import setup_logging
from lora_service import LoRAService
from model_downloader import ModelDownloader
from module_service import ModuleService
from workflow_service import EmptyUpload, WorkflowService

if sys.platform == "win32":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")

ROOT_DIR = Path(__file__).parent.parent
CONFIG_DIR = ROOT_DIR / "config"
COMFY_DIR = ROOT_DIR / "ComfyUI"
OUTPUT_DIR = COMFY_DIR / "output"
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8199")

setup_logging()          # configures the root logger; returns nothing
logger = logging.getLogger("fedda.server")

app = FastAPI(title="FEDDA Hub v4 Backend", version="4.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

workflow_service = WorkflowService(str(ROOT_DIR / "backend" / "workflows"))
module_service = ModuleService(CONFIG_DIR)
model_downloader = ModelDownloader(ROOT_DIR)
lora_service = LoRAService(ROOT_DIR)

# Node signatures: what makes a sampler a picker instead of a box you type
# "euler" into.
#
# This used to be read once at import from a file a script generates - and the
# file is gitignored, so no install has ever had one. Every FEDDA in the world
# started with an empty dict and fell back to plain text: 12 dropdowns and 6
# toggles across the app, gone, on every machine but the one the file was
# generated on.
#
# Shipping the file is not the fix either. It carries the *generating* machine's
# model lists - its LoRAs, its checkpoints - so every user would be shown a
# menu of files they do not have.
#
# So it is fetched from the ComfyUI this install runs, cached in memory, and
# written to disk so the next start is instant. ComfyUI is usually still
# booting when the backend comes up, which is the other half of why reading
# once at import was wrong.
_OBJECT_INFO_PATH = CONFIG_DIR / "object_info.cache.json"
_object_info_cache: Dict[str, Any] = descriptor.load_object_info(str(_OBJECT_INFO_PATH))
_object_info_lock = threading.Lock()
_object_info_next_try = 0.0
# Never fetched in this process yet: what is in memory came off disk and its
# model lists are as old as the file.
_object_info_fresh_at = 0.0

# How long a fetched snapshot is trusted. It holds two different kinds of
# fact - node signatures, which change only when a node pack is installed, and
# the contents of the model folders, which change whenever anything downloads
# one. The second is why this expires at all.
_OBJECT_INFO_TTL = 60.0


def object_info() -> Dict[str, Any]:
    """Node signatures and model lists, kept current with the running ComfyUI.

    The disk copy exists so a workflow can be described while ComfyUI is still
    booting, and it used to be the end of it: seeded at import, returned
    whenever it was non-empty, never replaced. So the model pickers showed
    whatever was on the machine the day the file was written. One install had
    a cache from a week earlier offering three diffusion models out of the
    eighty ComfyUI actually had - including every model the app's own
    downloader had fetched in between, none of which could be selected.

    Now the disk copy is a cold start only, and a fetched one expires: a model
    that finishes downloading is in the picker a minute later without a
    restart. A fetch that fails leaves what is already here, because a stale
    list is worth more than an empty one.
    """
    global _object_info_cache, _object_info_next_try, _object_info_fresh_at
    now = time.monotonic()
    if _object_info_cache and now - _object_info_fresh_at < _OBJECT_INFO_TTL:
        return _object_info_cache
    with _object_info_lock:
        now = time.monotonic()
        if _object_info_cache and now - _object_info_fresh_at < _OBJECT_INFO_TTL:
            return _object_info_cache
        # A ComfyUI that is still starting must not cost a 10-second timeout on
        # every request; try again in a moment instead.
        if now < _object_info_next_try:
            return _object_info_cache
        _object_info_next_try = now + 5.0
        try:
            response = requests.get(f"{COMFY_URL}/object_info", timeout=30)
            response.raise_for_status()
            info = response.json()
        except (requests.RequestException, ValueError) as exc:
            logger.debug("object_info not available yet (%s)", exc)
            return _object_info_cache
        if not isinstance(info, dict) or not info:
            return _object_info_cache
        changed = info != _object_info_cache
        _object_info_cache = info
        _object_info_fresh_at = time.monotonic()
        if changed:
            logger.info("object_info: %d node types from ComfyUI", len(info))
            try:
                _OBJECT_INFO_PATH.parent.mkdir(parents=True, exist_ok=True)
                _OBJECT_INFO_PATH.write_text(json.dumps(info), encoding="utf-8")
            except OSError as exc:
                # Not being able to cache it is a slow next start, not a failure.
                logger.debug("could not write %s (%s)", _OBJECT_INFO_PATH, exc)
        return _object_info_cache


# ----------------------------------------------------------------- health

def _installed_commit() -> str:
    """Which commit this install is running, short form.

    Worth the eight lines: when somebody else reports a bug there is no way
    to tell a fault from an install that predates the fix, and every answer
    starts by guessing. One URL settles it.
    """
    try:
        import subprocess
        out = subprocess.run(
            ["git", "-C", str(ROOT_DIR), "log", "-1", "--format=%h %s"],
            capture_output=True, text=True, timeout=5)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        # Not a clone, or no git on PATH. Not knowing is fine; failing is not.
        return ""


# Read once, at import, and never again. _installed_commit() asks git what is
# in the working tree, which is not the same question as what this process is
# running - after a pull the tree moves and the loaded code does not. Calling it
# per request made /health report a commit whose code had never been imported,
# and it did so twice in a row on 3 Sep 2026 while a fix sat unloaded: the
# endpoint said the bug was fixed, the behaviour said otherwise, and the
# endpoint was believed. A health check that overstates what is running is worse
# than one that says nothing, because it is consulted precisely when something
# looks wrong.
_RUNNING_COMMIT = _installed_commit()


@app.get("/health")
async def health() -> Dict[str, Any]:
    tree = _installed_commit()
    body: Dict[str, Any] = {"status": "ok", "version": "4.0.0",
                            "commit": _RUNNING_COMMIT}
    # Say so rather than let the difference be discovered by a fix that appears
    # not to work.
    if tree and tree != _RUNNING_COMMIT:
        body["tree_commit"] = tree
        body["restart_required"] = True
    return body


@app.get("/api/queue")
async def queue_depth() -> Dict[str, Any]:
    """What ComfyUI is running and what is waiting behind it.

    ComfyUI has always queued - submitting while a job runs adds to the line
    rather than being refused. The app was the only thing preventing it, by
    hiding Generate for the duration. This is what lets the button say how many
    are waiting instead of just going away.
    """
    try:
        response = requests.get(f"{COMFY_URL}/queue", timeout=5)
        response.raise_for_status()
        data = response.json()
    except (requests.RequestException, ValueError):
        return {"running": 0, "pending": 0, "available": False}
    return {"running": len(data.get("queue_running") or []),
            "pending": len(data.get("queue_pending") or []),
            "available": True}


@app.get("/api/system/comfy-status")
async def comfy_status() -> Dict[str, Any]:
    try:
        response = requests.get(f"{COMFY_URL}/system_stats", timeout=1.5)
        return {"connected": response.ok, "url": COMFY_URL}
    except requests.RequestException:
        return {"connected": False, "url": COMFY_URL}


@app.get("/api/hardware/stats")
async def hardware_stats() -> Dict[str, Any]:
    """GPU and RAM, straight from ComfyUI - it already reports both."""
    try:
        response = requests.get(f"{COMFY_URL}/system_stats", timeout=2)
        response.raise_for_status()
        stats = response.json()
    except (requests.RequestException, ValueError):
        return {"available": False}

    devices = stats.get("devices") or []
    gpu = devices[0] if devices else {}
    total = gpu.get("vram_total") or 0
    free = gpu.get("vram_free") or 0
    return {
        "available": bool(devices),
        "gpu_name": gpu.get("name", ""),
        "vram_total": total,
        "vram_free": free,
        "vram_used": max(total - free, 0),
        "system": stats.get("system", {}),
    }


# --------------------------------------------------------------- settings

def _runtime_settings() -> Dict[str, Any]:
    path = CONFIG_DIR / "runtime_settings.json"
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}


def _save_runtime_settings(values: Dict[str, Any]) -> None:
    path = CONFIG_DIR / "runtime_settings.json"
    current = _runtime_settings()
    current.update(values)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, indent=2), encoding="utf-8")


class FoldersRequest(BaseModel):
    # Plural, and a list. Anyone with a collection has it spread over whatever
    # drive had room at the time, and one folder meant re-downloading models
    # already sitting on the machine.
    extra_models_paths: List[str] = []
    # The singular is still accepted so a page loaded before an update, or a
    # settings file written by one, does not lose its folder on the next save.
    extra_models_path: str = ""
    output_path: str = ""
    input_path: str = ""


def _folder_defaults() -> Dict[str, str]:
    """What each single-value folder is when the user has not chosen one.

    The extra model folders are a list and have no default, so they are not
    here - see _extra_models_setting().
    """
    return {
        "output_path": str(ROOT_DIR / "ComfyUI" / "output"),
        "input_path": str(ROOT_DIR / "ComfyUI" / "input"),
    }


def _extra_models_setting() -> List[str]:
    """The configured extra model folders, reading either shape.

    Installs written before the list existed hold a single string under the
    singular key; both are read so an update never drops a folder somebody
    already told us about.
    """
    settings = _runtime_settings()
    value = settings.get("extra_models_paths")
    if value is None:
        value = settings.get("extra_models_path")
    return model_links.extra_paths(value)


def _check_folder(label: str, raw_value: str, needs_write: bool) -> str:
    """Validate one path, or raise with something the user can act on.

    Checked on the way in rather than on the way out. A bad path saved here
    does not fail until a generate reaches for it, by which point the error
    surfaces as a broken render rather than as a folder someone mistyped.
    """
    value = (raw_value or "").strip().strip('"')
    if not value:
        return ""
    path = Path(value)
    if not path.exists():
        raise HTTPException(status_code=400, detail=f"{label}: {value} does not exist")
    if not path.is_dir():
        raise HTTPException(status_code=400, detail=f"{label}: {value} is not a folder")
    if needs_write:
        probe = path / ".fedda_write_test"
        try:
            probe.write_text("", encoding="utf-8")
            probe.unlink()
        except OSError:
            raise HTTPException(status_code=400,
                                detail=f"{label}: cannot write to {value}")
    return str(path)


@app.get("/api/settings/folders")
async def get_folders() -> Dict[str, Any]:
    settings = _runtime_settings()
    defaults = _folder_defaults()
    paths: Dict[str, Any] = {
        key: str(settings.get(key) or "").strip() for key in defaults}
    paths["extra_models_paths"] = _extra_models_setting()
    return {
        "success": True,
        "paths": paths,
        "defaults": defaults,
        # Every one of these is read at startup, so nothing changes until
        # FEDDA restarts. The dialog says so rather than implying otherwise.
        "requires_restart": True,
    }


class BrowseRequest(BaseModel):
    """Where the picker should open, and what it should say at the top."""
    start: str = ""
    title: str = "Choose a folder"


# Defined with `def`, not `async def`, on purpose: it blocks until somebody
# clicks, and FastAPI runs a sync endpoint in its threadpool. As a coroutine it
# would hold the event loop and freeze every other request in the app for as
# long as the dialog stood open.
@app.post("/api/settings/browse-folder")
def browse_folder(req: BrowseRequest) -> Dict[str, Any]:
    """Open Windows' own folder picker and return what was chosen.

    The browser cannot do this. An `<input type="file" webkitdirectory>` gives
    the page a list of names and a fake path; the real location is withheld
    deliberately and no markup gets it back. Asking people to copy a path out
    of Explorer and paste it in was the only thing left, and it is a poor thing
    to ask.

    The backend is the part that runs on the user's own machine, so it is the
    part that can show a picker. Nothing is opened without a click here - the
    dialog only ever appears in response to this request.
    """
    if os.name != "nt":
        raise HTTPException(status_code=501,
                            detail="The folder picker is Windows only")
    script = ROOT_DIR / "scripts" / "pick_folder.ps1"
    if not script.is_file():
        raise HTTPException(status_code=500, detail="pick_folder.ps1 is missing")
    try:
        # -STA because Windows Forms needs a single-threaded apartment and
        # returns nothing without one, which is indistinguishable from Cancel.
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
             "-File", str(script), "-Start", req.start, "-Title", req.title],
            capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        # Ten minutes means the dialog is open and forgotten, not that anything
        # failed. Say so rather than reporting an error for a picker that is
        # still sitting there.
        return {"success": True, "cancelled": True}
    except OSError as exc:
        raise HTTPException(status_code=500,
                            detail=f"Could not open the picker: {exc}")
    chosen = (completed.stdout or "").strip().splitlines()
    path = chosen[-1].strip() if chosen else ""
    if not path:
        return {"success": True, "cancelled": True}
    return {"success": True, "cancelled": False, "path": path}


@app.post("/api/settings/folders")
async def set_folders(req: FoldersRequest) -> Dict[str, Any]:
    # Both shapes are merged before validation, so a page still posting the
    # singular adds to the list rather than replacing it with nothing.
    wanted = model_links.extra_paths(
        list(req.extra_models_paths) + [req.extra_models_path])
    extras = [_check_folder("Extra models", one, needs_write=False) for one in wanted]
    extras = model_links.extra_paths(extras)
    output = _check_folder("Output", req.output_path, needs_write=True)
    inp = _check_folder("Input", req.input_path, needs_write=True)

    # An extra models tree that is really FEDDA's own is not an extra tree,
    # and listing it twice would make ComfyUI resolve every model through two
    # identical roots.
    own_models = (ROOT_DIR / "ComfyUI" / "models").resolve()
    for one in extras:
        if Path(one).resolve() == own_models:
            raise HTTPException(
                status_code=400,
                detail="Extra models: that is FEDDA's own models folder, which is already used")

    paths: Dict[str, Any] = {"extra_models_paths": extras,
                             "output_path": output, "input_path": inp}
    # The superseded singular is cleared rather than left behind, or a reader
    # that still consults it would find a folder the user has since removed.
    paths["extra_models_path"] = ""
    _save_runtime_settings(paths)
    paths.pop("extra_models_path", None)
    return {"success": True, "paths": paths, "requires_restart": True}


class SecretRequest(BaseModel):
    """A saved credential, under whichever name the caller uses for it.

    The dialog posts `{"token": ...}` for Hugging Face and `{"api_key": ...}`
    for the others - v3's request models, and the shape it was written
    against. v4 asked for `value`, which is a field none of them send: with a
    default of "" the unknown key was ignored, the token saved as empty, and
    the pill went straight back to "HF Token Missing" with no error anywhere.
    A silent success is worse than a rejection.

    All three are accepted rather than picking one, because all three are
    already in use and renaming a field in the dialog would break the other
    two endpoints in the same way.
    """
    # None, not "": an empty string is a deliberate "remove the saved key",
    # and a body carrying no recognised field at all is a caller sending the
    # wrong shape. Those must not look the same - telling them apart is what
    # turns this bug into a 400 instead of a key that vanishes quietly.
    value: Optional[str] = None
    token: Optional[str] = None
    api_key: Optional[str] = None

    def secret(self) -> str:
        for candidate in (self.token, self.api_key, self.value):
            if candidate is not None:
                return candidate.strip()
        raise HTTPException(
            status_code=400,
            detail="No credential in the request. Expected one of: token, api_key, value.")


def _secret_status(key: str) -> Dict[str, Any]:
    value = str(_runtime_settings().get(key) or "").strip()
    return {"configured": bool(value)}


@app.get("/api/settings/hf-token/status")
async def hf_token_status() -> Dict[str, Any]:
    return _secret_status("hf_token")


@app.post("/api/settings/hf-token")
async def set_hf_token(req: SecretRequest) -> Dict[str, Any]:
    secret = req.secret()
    _save_runtime_settings({"hf_token": secret})
    return {"success": True, "configured": bool(secret)}


@app.get("/api/settings/civitai-key/status")
async def civitai_key_status() -> Dict[str, Any]:
    return _secret_status("civitai_key")


@app.post("/api/settings/civitai-key")
async def set_civitai_key(req: SecretRequest) -> Dict[str, Any]:
    secret = req.secret()
    _save_runtime_settings({"civitai_key": secret})
    return {"success": True, "configured": bool(secret)}


# ---------------------------------------------------------------- modules

@app.get("/api/modules/install-state")
async def modules_install_state() -> Dict[str, Any]:
    """What this install actually has, which is what the UI degrades against."""
    # Pack modules are merged inside module_service, so they are in "modules",
    # in "enabled_module_ids" and in the counts already - and, more to the
    # point, in workflow_index(), which is what decides whether a workflow is
    # allowed to run. Merging them a second time here is how those two answers
    # drifted apart in the first place.
    state = module_service.get_install_state()

    return {
        "version": 1,
        **state,
        # Top-level cards a pack brings, which are not modules and so have
        # nowhere else to come from. Empty for an install with no packs, which
        # is every install that has not been given one.
        "areas": packs.areas(packs.pack_roots(_runtime_settings())),
    }


# --------------------------------------------------------------- workflows

def _load_graph(mapping: Dict[str, Any]) -> Dict[str, Any]:
    path = workflow_service.get_workflow_path(mapping.get("filename", ""))
    if not path:
        return {}
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            graph = json.load(fh)
    except (OSError, ValueError):
        return {}
    if not workflow_service.is_api_format(graph):
        graph = workflow_service.convert_ui_to_api(graph)
    return graph


@app.get("/api/workflow/list")
async def list_workflows() -> Dict[str, Any]:
    mappings = workflow_service.load_mapping()
    items = []
    for workflow_id, mapping in mappings.items():
        if workflow_id.startswith("_"):
            continue  # `_note` and friends are documentation, not workflows
        items.append({
            "id": workflow_id,
            "name": mapping.get("name", workflow_id),
            "description": mapping.get("description", ""),
            "module": mapping.get("module", ""),
            "available": module_service.is_workflow_available(workflow_id).get("available", True),
        })
    return {"workflows": items}


# The card's size, asked once. ComfyUI reports it and it does not change while
# the app runs, so polling it per schema request would put a network round trip
# in front of every page open for an answer that never moves.
_CARD_VRAM_GB: Optional[float] = None


def _card_vram_gb() -> float:
    """How much VRAM this machine has, in GB, or 0 when it cannot be read.

    Zero on purpose rather than a guess: every caller treats it as "do not
    decide for the user", which is the right behaviour when the answer is
    unknown. A wrong guess here would silently move settings on somebody's
    machine on the strength of nothing.
    """
    global _CARD_VRAM_GB
    if _CARD_VRAM_GB is not None:
        return _CARD_VRAM_GB
    total = 0.0
    try:
        response = requests.get(f"{COMFY_URL}/system_stats", timeout=3)
        response.raise_for_status()
        devices = response.json().get("devices") or []
        if devices:
            total = float(devices[0].get("vram_total") or 0) / 1024 ** 3
    except (requests.RequestException, ValueError, TypeError, IndexError):
        total = 0.0
    # Not cached when it failed - ComfyUI may simply not be up yet, and the
    # next page open should ask again rather than assume nothing forever.
    if total > 0:
        _CARD_VRAM_GB = total
    return total


@app.get("/api/workflow/schema/{workflow_id}")
async def workflow_schema(workflow_id: str) -> Dict[str, Any]:
    """The controls this workflow needs, and what kind each one is.

    This is the whole reason v4 has one generate page instead of sixty-one.
    """
    mapping = workflow_service.load_mapping().get(workflow_id)
    if not mapping:
        raise HTTPException(status_code=404, detail=f"unknown workflow '{workflow_id}'")
    graph = _load_graph(mapping)
    # Settled here rather than in the graph, because it depends on the machine
    # rather than on the workflow: the same encoder belongs on the card in one
    # house and on the processor in the next.
    overrides: Dict[str, Dict[str, Any]] = {}
    placement = model_links.encoder_placement(
        graph, ROOT_DIR, _extra_models_setting(), _card_vram_gb())
    if placement:
        overrides["encoder_device"] = placement
    described = descriptor.describe_workflow(
        workflow_id, mapping, graph, object_info(), overrides)
    _prefer_installed_builds(described, _extra_models_setting())
    return described


def _prefer_installed_builds(described: Dict[str, Any], extra: List[str]) -> None:
    """Open a model picker on a build this machine actually has.

    A graph is saved with whichever build its author was using, and the picker
    lists every build the node knows about - installed or not. z-image-detailed
    named SeedVR2's 7B sharp, fourteen gigabytes, on a machine already holding
    the 3B. Nothing said so: ten options, one chosen, no indication that nine of
    them were not there and that the tenth was a download.

    The graph's own choice always wins when it is present, because it is the
    one the workflow was built and tested against. This only speaks up when
    that file is absent and something equivalent is not, and it says which.

    Modifies in place; the caller has just built the fields.
    """
    for field in described.get("fields") or []:
        options = field.get("options") or []
        current = field.get("default")
        if not options or not isinstance(current, str):
            continue
        # Model files only. A sampler name is a combo too and has nothing to
        # do with the disk.
        if not current.lower().endswith((".safetensors", ".gguf", ".pt", ".pth",
                                         ".onnx", ".ckpt")):
            continue
        if model_links.find_anywhere(current, ROOT_DIR, extra) is not None:
            continue
        here = [o for o in options if isinstance(o, str)
                and model_links.find_anywhere(o, ROOT_DIR, extra) is not None]
        if not here:
            continue
        field["default"] = here[0]
        field["note"] = (
            "%s is not on this machine. Opened on %s, which is - change it "
            "back and it will be downloaded." % (current, here[0]))


# Smaller builds of a model a graph already names. Keyed by what the graph
# carries, so the dialog can offer them beside it without the mapping or the
# graph mentioning them at all.
#
# MiniMax ships at Q3_K_M, which is 15.6 GB and wants a 24 GB card. These are
# the same model between 8 and 11 GB, and downloading one is what makes the
# workflow's model picker useful on a 12 GB card.
_SMALLER_BUILDS: Dict[str, List[str]] = {
    "MiniMax-H3-FL2VA-Q3_K_M.gguf": [
        "minimax_h3_fl2va_pruned-UD-Q3_K_XL.gguf",
        "minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf",
        "minimax_h3_fl2va_pruned-Q4_K.gguf",
    ],
    "MiniMax-H3-Ref2VA-Q3_K_M.gguf": [
        "minimax_h3_ref2va_pruned-UD-Q3_K_XL.gguf",
        "minimax_h3_ref2va_pruned-UD-Q2_K_XL.gguf",
        "minimax_h3_ref2va_pruned-Q4_K.gguf",
    ],
    # Z-Image ships bf16 and wants 13.9 GB resident, which no 2080 and no 8 GB
    # card can hold. These two bring the peak to roughly 8.2 GB between them.
    # Offered, never substituted: a 24 GB card should keep the full-precision
    # build, and quantisation is a trade the owner of the card makes.
    "z_image_turbo_bf16.safetensors": [
        "z_image_turbo_int8_convrot.safetensors",
    ],
    "qwen_3_4b.safetensors": [
        "qwen_3_4b_fp8_mixed.safetensors",
    ],
}


# A gated repo's answer for this machine's token, remembered for the session.
# It is one network call and it cannot change without the user leaving the app
# to accept a licence, so asking again on every render would be a round trip
# per row for an answer that only moves when they come back.
_GATE_ACCESS: Dict[str, bool] = {}


def _gated_access(url: str) -> Optional[bool]:
    """Does the saved token already open this repo? None when unknown.

    Asked before the user presses anything. Being told to go and accept a
    licence you accepted last week is worse than being told nothing - and the
    only way to know is to try, so this tries with a HEAD rather than making
    them start a download to find out.
    """
    if not url or "huggingface.co" not in url:
        return None
    if url in _GATE_ACCESS:
        return _GATE_ACCESS[url]
    token = str(_runtime_settings().get("hf_token") or "").strip()
    if not token:
        return False
    try:
        response = requests.head(
            url, headers={"Authorization": f"Bearer {token}"},
            allow_redirects=True, timeout=10)
    except requests.RequestException:
        return None                      # offline says nothing about the gate
    ok = response.status_code not in (401, 403)
    # Only a yes is remembered. Access is granted by the user leaving the app,
    # accepting a licence and coming back, so a cached no would survive exactly
    # the event it needs to notice - and the page would keep telling them to
    # accept something they had just accepted. A yes cannot go stale that way.
    if ok:
        _GATE_ACCESS[url] = True
    return ok


def _workflow_models(workflow_id: str) -> List[Dict[str, Any]]:
    """Every model this workflow needs, and where each one already is.

    Two sources, unioned by filename. `modules.json` names the files a module
    needs and `model_downloader` holds their URLs; a graph may also declare
    its own downloads inline through a HuggingFaceDownloader node. Today the
    first supplies everything and the second is empty for all six workflows -
    which is why reading only the graph, as the first version of this did,
    reported nothing to download while the wire was saturated.
    """
    extra = _extra_models_setting()
    mapping = workflow_service.load_mapping().get(workflow_id)
    if not mapping:
        return []
    path = workflow_service.get_workflow_path(mapping.get("filename", ""))
    if not path:
        return []
    graph = model_links.load_graph(path)

    files: List[Dict[str, Any]] = []
    seen = set()

    for item in model_links.models_from_graph(graph):
        name = item["filename"]
        seen.add(name.lower())
        spec = model_downloader.spec_for(name)
        # Not every spec places its file by folder: some carry a
        # root_relative_path instead, and reading relative_dir off those
        # raises rather than falling back.
        folder = item["folder"]
        if spec and spec.get("relative_dir"):
            folder = str(spec["relative_dir"]).replace("\\", "/")

        # A spec with root_relative_path puts its file at one exact place
        # outside the models tree - DWPose lands in the controlnet_aux node's
        # own ckpts folder, which is where that node looks for it. Neither the
        # folder search nor the tree walk below goes there, so those files were
        # downloaded correctly, reported missing anyway, and would have been
        # downloaded again on every visit to the page.
        #
        # This asks the same question the downloader answers when it decides
        # whether to fetch, so the two cannot disagree about the same file.
        found = None
        if spec and spec.get("root_relative_path"):
            exact = ROOT_DIR / spec["root_relative_path"]
            if exact.is_file():
                found = exact

        # Otherwise the spec knows the folder, so ask there and only walk the
        # tree for files it does not place.
        if found is None:
            found = (model_links.find_existing_model(folder, name, ROOT_DIR, extra)
                     if folder else None)
        if found is None:
            found = model_links.find_anywhere(name, ROOT_DIR, extra)

        # Why this one will not be downloaded, when it will not be. Three
        # different situations drew identically before - as a row with no
        # size and a Download button that started nothing - and only one of
        # them was actually wrong.
        note = ""
        if spec and spec.get("fetched_by"):
            note = ("%s downloads this itself the first time it runs."
                    % spec["fetched_by"])
        elif not spec:
            note = ("Nothing knows where to download this - it has no entry "
                    "in the model list.")
        licence_url = ""
        if spec and spec.get("gated"):
            source = str(spec.get("url") or "")
            repo = (source.split("/resolve/")[0] if "/resolve/" in source else "")
            licence_url = repo
            access = _gated_access(source)
            if access is True:
                note = ("Licence accepted on your account - this one is ready "
                        "to download.")
                licence_url = ""
            elif str(_runtime_settings().get("hf_token") or "").strip():
                note = ("Accept this model's licence on Hugging Face, then "
                        "press Download. Your token is already saved.")
            else:
                note = ("Accept this model's licence on Hugging Face and save "
                        "your token in the top bar, then press Download.")

        # A part-finished download is not nothing, and it was invisible. The
        # downloader resumes from .fedda_tmp with a Range request, so those
        # bytes are a head start rather than waste - but an interrupted 24 GB
        # model leaves nine gigabytes on the disk that the app never mentions,
        # and the row looked exactly like one that had never been started.
        partial_gb = 0.0
        if found is None and spec:
            try:
                tmp = Path(str(model_downloader._dest_path_for_spec(spec, name))
                           + ".fedda_tmp")
                if tmp.is_file():
                    partial_gb = round(tmp.stat().st_size / 1024 ** 3, 2)
            except (OSError, AttributeError, KeyError):
                partial_gb = 0.0
        if partial_gb:
            note = (("%s " % note if note else "")
                    + "%.2f GB of this is already downloaded and will resume."
                    % partial_gb).strip()

        files.append({
            "filename": name,
            "folder": folder,
            "url": str(spec.get("url") or "") if spec else "",
            "path": (str(model_downloader._dest_path_for_spec(spec, name))
                     if spec else ""),
            "exists": found is not None,
            "size_bytes": found.stat().st_size if found else 0,
            # Reported rather than dropped: a model the app will not fetch is
            # something the user has to know about, not something to hide.
            **({"no_source": True, "note": note, "partial_gb": partial_gb, "licence_url": licence_url} if note else {}),
        })

    # Smaller builds of whatever this graph loads, offered rather than needed.
    # `optional` keeps them out of the missing count and out of the way of a
    # run; the dialog lists them under their own heading.
    for name in [f["filename"] for f in list(files)]:
        for alt in _SMALLER_BUILDS.get(name, []):
            if alt.lower() in seen:
                continue
            spec = model_downloader.spec_for(alt)
            if not spec:
                continue
            seen.add(alt.lower())
            found = model_links.find_anywhere(alt, ROOT_DIR, extra)
            files.append({
                "filename": alt,
                "folder": str(spec["relative_dir"]).replace("\\", "/"),
                "url": str(spec.get("url") or ""),
                "path": str(model_downloader._dest_path_for_spec(spec, alt)),
                "exists": found is not None,
                "size_bytes": found.stat().st_size if found else 0,
                "optional": True,
                "alternative_to": name,
            })

    # A graph may also declare downloads inline through a
    # HuggingFaceDownloader node. None of the six do today.
    for item in model_links.parse_download_links(graph, ROOT_DIR, extra):
        if item["filename"].lower() not in seen:
            files.append(item)
            seen.add(item["filename"].lower())

    return files


@app.get("/api/workflow/model-status/{workflow_id}")
async def workflow_model_status(workflow_id: str) -> Dict[str, Any]:
    """Which of this workflow's models this machine already has.

    Read off the graph rather than from a list in modules.json: the
    HuggingFaceDownloader node carries the URLs, so a workflow states its own
    requirements and adopting one does not mean maintaining an inventory
    beside it.

    "Already has" means anywhere ComfyUI will look, which includes the folder
    Settings points at. Asking only about our own tree is what once made an
    install with the models already attached refuse to generate and start
    re-downloading twenty gigabytes it had.
    """
    files = _workflow_models(workflow_id)
    # What it will want resident, beside what the card has. The page can then
    # say "this fits" or "this will stream" before a run rather than after.
    mapping = workflow_service.load_mapping().get(workflow_id) or {}
    path = workflow_service.get_workflow_path(mapping.get("filename", ""))
    vram = (model_links.vram_estimate(
        model_links.load_graph(path), ROOT_DIR,
        _extra_models_setting())
        if path else {})
    return {"files": files,
            "ready": all(f["exists"] for f in files if not f.get("optional")),
            "vram": vram}


@app.get("/api/workflow/download-live-progress/{workflow_id}")
async def workflow_download_live_progress(workflow_id: str) -> Dict[str, Any]:
    """Bytes on disk against bytes expected, polled while a download runs.

    This is what the banner draws. Without it the transfer ran at full speed
    with nothing on screen at all - the endpoint the UI polls simply was not
    there, and a 404 every two seconds looks exactly like an idle app.
    """
    token = str(_runtime_settings().get("hf_token") or "").strip()
    return {"files": model_links.live_progress(
        _workflow_models(workflow_id), token, model_downloader.get_progress)}


@app.post("/api/workflow/download-models/{workflow_id}")
async def workflow_download_models(workflow_id: str) -> Dict[str, Any]:
    """Fetch everything missing, without running the workflow."""
    files = _workflow_models(workflow_id)
    if not files:
        raise HTTPException(status_code=404,
                            detail=f"No models declared by '{workflow_id}'")

    token = str(_runtime_settings().get("hf_token") or "").strip()
    started, already = [], []
    for item in files:
        if item["exists"] or item.get("optional"):
            # An optional build is downloaded on request, never by
            # "fetch what is missing" - it is an alternative, not a gap.
            already.append(item["filename"])
            continue
        if not item.get("url"):
            continue  # named by the module, but nothing knows where to get it
        # The token goes only to Hugging Face. Sending it to a mirror or a
        # CDN would hand someone else the user's credential.
        headers = ({"Authorization": f"Bearer {token}"}
                   if token and "huggingface.co" in item["url"] else None)
        dest = Path(item["path"])
        dest.parent.mkdir(parents=True, exist_ok=True)
        model_downloader.start_url_download(
            item["url"], dest, item["filename"], headers=headers)
        started.append(item["filename"])

    logger.info("download %s: %d starting, %d already here",
                workflow_id, len(started), len(already))
    return {"success": True, "started": started, "already_present": already}


@app.post("/api/models/fetch/{filename}")
async def fetch_one_model(filename: str) -> Dict[str, Any]:
    """Download one named model.

    The workflow-level download fetches what is missing, which is right for a
    gap and wrong for a choice: a smaller build of a model you already have is
    not missing, it is an alternative, and asking for it has to be possible
    without pretending otherwise.
    """
    spec = model_downloader.spec_for(filename)
    if not spec or not spec.get("url"):
        raise HTTPException(status_code=404,
                            detail="Nothing knows where to download %r." % filename)
    token = str(_runtime_settings().get("hf_token") or "").strip()
    headers = ({"Authorization": f"Bearer {token}"}
               if token and "huggingface.co" in str(spec["url"]) else None)
    dest = model_downloader._dest_path_for_spec(spec, filename)
    dest.parent.mkdir(parents=True, exist_ok=True)
    state = model_downloader.start_url_download(
        str(spec["url"]), dest, filename, headers=headers)
    logger.info("fetch %s: %s", filename, state)
    return {"success": True, "filename": filename, "state": state}


@app.get("/api/models/status/{filename}")
async def model_status(filename: str) -> Dict[str, Any]:
    return model_downloader.get_progress(filename)


# ---------------------------------------------------------------- generate

class GenerateRequest(BaseModel):
    workflow_id: str
    params: Dict[str, Any] = {}
    # Whose websocket should hear about this run.
    #
    # ComfyUI addresses its execution messages - progress, previews, and the
    # `executed` event carrying the finished filenames - to the client_id that
    # submitted the prompt. This used to be hardcoded to "fedda_v4", a name no
    # socket was ever registered under, so every one of those messages was
    # delivered to nobody: no progress bar, no live preview, and a Recent
    # Generations strip that stayed empty however many pictures were made.
    #
    # The browser opens its own socket as `fedda_web_...` and now sends that
    # name here. The old constant remains the fallback, for a caller that has
    # no socket of its own and does not need to be told anything.
    client_id: str = "fedda_v4"


@app.post("/api/generate")
async def generate(req: GenerateRequest) -> Dict[str, Any]:
    availability = module_service.is_workflow_available(req.workflow_id)
    if not availability.get("available", True):
        raise HTTPException(
            status_code=403,
            detail=availability.get("detail")
            or f"'{req.workflow_id}' is not installed on this machine",
        )

    # A few nodes want their value in a shape the control cannot produce -
    # Pixaroma packs a prompt into a hidden JSON string, for one. The mapping
    # names an encoder for those; everything else passes through untouched.
    mapping = workflow_service.load_mapping().get(req.workflow_id) or {}

    # An unfilled upload used to reach ComfyUI as an empty string, and LoadImage
    # would try to open the input *directory* as a file: "Permission denied:
    # ...\ComfyUI\input", from av.error, several nodes into the run. The
    # cause is not in that message anywhere.
    #
    # Same shape as the empty-string-over-a-number bug descriptor.py records:
    # a control that was never filled must not overwrite the graph, and here it
    # must not start the run at all - there is no sensible picture to fall back
    # on.
    graph_desc = descriptor.describe_workflow(
        req.workflow_id, mapping, _load_graph(mapping), object_info())
    def _filled(value: Any) -> bool:
        # An audio control hands over an object. str() of a dict is never
        # empty, so the plain emptiness test would call an unfilled one filled.
        if isinstance(value, dict):
            return bool(str(value.get("file") or "").strip())
        return bool(str(value or "").strip())

    missing = [f["label"] for f in graph_desc["fields"]
               if f.get("required") and not _filled(req.params.get(f["key"]))]
    if missing:
        raise HTTPException(
            status_code=400,
            detail="Fill these in first: %s" % ", ".join(missing))

    # -1 is this app's way of saying "pick one", and it stops here. ComfyUI
    # declares a seed as min 0 and refuses anything below it, so the graph must
    # never see the sentinel. Rolled per field, so a workflow with two seeds
    # gets two different ones rather than the same value twice.
    for field in graph_desc["fields"]:
        if field.get("role") != "seed":
            continue
        try:
            given = int(req.params.get(field["key"]))
        except (TypeError, ValueError):
            continue
        if given < 0:
            req.params[field["key"]] = random.randint(0, 2 ** 53 - 1)

    params = encoders.apply(mapping, req.params)

    try:
        payload = workflow_service.prepare_payload(req.workflow_id, params)
    except EmptyUpload as exc:
        # The check above should have caught this. That it did not means a
        # loader slot the descriptor does not mark required, so say which
        # one rather than letting an empty filename reach ComfyUI and come
        # back as a permission error on its own input folder.
        raise HTTPException(status_code=400,
                            detail="Fill these in first: %s" % exc)
    if not payload:
        raise HTTPException(status_code=400,
                            detail=f"Could not build a graph for '{req.workflow_id}'")

    try:
        submit = requests.post(
            f"{COMFY_URL}/prompt",
            json={"prompt": payload, "client_id": req.client_id},
            timeout=20,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=503,
                            detail=f"ComfyUI is not answering on {COMFY_URL}: {exc}")

    if not submit.ok:
        # ComfyUI's own rejection is far more useful than a generic 500 - it
        # names the node and the input it refused.
        raise HTTPException(status_code=400, detail=f"ComfyUI refused the graph: {submit.text}")

    prompt_id = submit.json().get("prompt_id")
    if not prompt_id:
        raise HTTPException(status_code=502, detail="ComfyUI returned no prompt_id")

    logger.info("queued %s as %s", req.workflow_id, prompt_id)
    return {"success": True, "prompt_id": prompt_id}


@app.post("/api/generate/cancel")
async def cancel_generation() -> Dict[str, Any]:
    try:
        requests.post(f"{COMFY_URL}/interrupt", timeout=5)
        return {"success": True}
    except requests.RequestException as exc:
        return {"success": False, "detail": str(exc)}


# Failures we can say something better about than the raw text. Keyed by a
# fragment that identifies one, mapped to what the person can actually do.
_KNOWN_FAILURES = [
    ("failed to extract audio",
     "That video has no sound track, and this workflow needs one. Add audio to "
     "the clip, or pick a workflow that does not use it."),
    ("reference videos need at least",
     "That video is too short. MiniMax needs at least five frames, which is "
     "about a fifth of a second."),
    ("out of memory",
     "The card ran out of memory. Try a smaller size or a shorter clip, or a "
     "smaller build in the model picker."),
]


def _failure_detail(messages: List[Any]) -> str:
    """Why a run failed, in a sentence rather than an event tuple.

    ComfyUI reports a failure as ['execution_error', {...}], and this used to
    hand the whole thing over with str(). The useful part is one field inside
    that dict; everything around it is prompt ids and node bookkeeping. Worse,
    a node that shells out puts the tool's entire output in the message - a
    silent video failed with ffmpeg's version banner and configure line, which
    tells a person nothing about the video they just chose.

    So: the exception's own message, named by the node it came from, and for
    the handful we have seen, a sentence saying what to do instead.
    """
    if not messages:
        return "ComfyUI reported an error"
    last = messages[-1]
    info = last[1] if isinstance(last, (list, tuple)) and len(last) > 1 else last
    if not isinstance(info, dict):
        return str(last)[:400]
    raw_message = str(info.get("exception_message") or "").strip()
    node = str(info.get("node_type") or "")
    low = raw_message.lower()
    for fragment, plain in _KNOWN_FAILURES:
        if fragment in low:
            return plain
    if not raw_message:
        return "ComfyUI reported an error in %s" % (node or "one of the nodes")
    # First line only. A traceback belongs in the log, not in a dialog.
    first = raw_message.splitlines()[0].strip()
    return ("%s: %s" % (node, first)) if node else first


def _outputs_from_history(entry: Dict[str, Any]) -> List[str]:
    """Every file the run wrote, as URLs the frontend can load.

    Reads any key holding a list of {filename: ...} rather than only "images".
    ComfyUI lets each save node name its own output key, and the four in use
    here do not agree: SaveImage and PixaromaSaveMp4 say "images", SaveVideo
    says "videos", and VHS_VideoCombine says "gifs" whatever it actually wrote.

    Seventeen of the forty graphs save through VHS_VideoCombine. Every one of
    those runs finished, wrote its mp4, and showed nothing in the app - the file
    was on disk and ComfyUI had reported it under a key this function did not
    read. A run that succeeds and appears to have produced nothing is worse than
    one that fails, because there is nothing to go and look up.

    Naming the four keys would work until the next save node arrives with a
    fifth. The shape is the reliable part, so that is what is matched.
    """
    urls: List[str] = []
    seen = set()
    for node_output in (entry.get("outputs") or {}).values():
        if not isinstance(node_output, dict):
            continue
        for items in node_output.values():
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                filename = item.get("filename")
                if not filename:
                    continue
                url = (
                    f"{COMFY_URL}/view?filename={filename}"
                    f"&subfolder={item.get('subfolder', '')}"
                    f"&type={item.get('type', 'output')}"
                )
                # A node can list one file under two keys; the strip must not
                # show it twice.
                if url in seen:
                    continue
                seen.add(url)
                urls.append(url)
    return urls


# Runs whose cache has already been released. The status endpoint is polled
# every second or two, and asking ComfyUI to free memory on every poll would
# be a flag set hundreds of times for one run.
_released: "OrderedDict[str, bool]" = OrderedDict()


def _release_cache(prompt_id: str) -> None:
    """Hand cached VRAM back to the driver, once, when a run finishes.

    `unload_models` stays false on purpose. This is the cheap half - free
    blocks returned and a garbage collection - not throwing away weights that
    the next run will only have to read from disk again.
    """
    if prompt_id in _released:
        return
    _released[prompt_id] = True
    while len(_released) > 64:
        _released.popitem(last=False)
    try:
        requests.post(f"{COMFY_URL}/free",
                      json={"free_memory": True, "unload_models": False},
                      timeout=5)
    except requests.RequestException as exc:
        # Not freeing is a slower next run, not a failure.
        logger.debug("could not free ComfyUI cache (%s)", exc)


@app.get("/api/generate/status/{prompt_id}")
async def generation_status(prompt_id: str, workflow_id: str = "") -> Dict[str, Any]:
    try:
        response = requests.get(f"{COMFY_URL}/history/{prompt_id}", timeout=10)
        history = response.json() if response.ok else {}
    except (requests.RequestException, ValueError):
        return {"status": "running"}

    entry = history.get(prompt_id)
    if not entry:
        # Not in history yet means queued or executing, not lost.
        return {"status": "running"}

    status = (entry.get("status") or {})
    if status.get("status_str") == "error":
        return {"status": "failed",
                "detail": _failure_detail(status.get("messages") or [])}

    images = _outputs_from_history(entry)
    if status.get("completed") or images:
        _release_cache(prompt_id)
        return {"status": "completed", "images": images, "prompt_id": prompt_id}
    return {"status": "running"}


# ------------------------------------------------------------------ upload

# ComfyUI resolves a workflow's `image` input against its own input folder, so
# an upload is a copy into that folder and the filename it answers with. The
# app never keeps its own copy: two folders holding the same picture is how the
# two disagree later.
_UPLOAD_MAX_BYTES = 64 * 1024 * 1024
_UPLOAD_TYPES = ("image/", "video/", "audio/")


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)) -> Dict[str, Any]:
    """Put a file where ComfyUI can find it, and return the name it gave it."""
    content_type = str(file.content_type or "")
    if content_type and not content_type.startswith(_UPLOAD_TYPES):
        raise HTTPException(status_code=415,
                            detail=f"{content_type} is not an image, video or audio file")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="The file was empty")
    # Read first, then check. FastAPI spools a large upload to disk rather than
    # holding it in memory, so the cap is about what ComfyUI is asked to store,
    # not about surviving the request.
    if len(content) > _UPLOAD_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"{len(content) // (1024 * 1024)} MB is over the "
                   f"{_UPLOAD_MAX_BYTES // (1024 * 1024)} MB limit")

    try:
        response = requests.post(
            f"{COMFY_URL}/upload/image",
            files={"image": (file.filename, content,
                            content_type or "application/octet-stream")},
            # An upload competes with whatever ComfyUI is rendering, and a 4K
            # frame over a busy event loop is not a five-second operation.
            timeout=180,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=503,
                            detail=f"ComfyUI is not answering on {COMFY_URL}: {exc}")

    if not response.ok:
        raise HTTPException(status_code=502,
                            detail=f"ComfyUI refused the upload: {response.text}")

    data = response.json()
    # ComfyUI renames on collision - image.png becomes image (2).png - so the
    # name it answers with is the one the graph must reference, never the one
    # that was sent. A subfolder comes back when it stored one; the graph slot
    # takes the two joined.
    name = data.get("name") or file.filename
    subfolder = str(data.get("subfolder") or "")
    logger.info("uploaded %s as %s", file.filename, name)
    return {
        "success": True,
        "filename": f"{subfolder}/{name}" if subfolder else name,
        "name": name,
        "subfolder": subfolder,
        "url": f"{COMFY_URL}/view?filename={name}&subfolder={subfolder}&type=input",
    }


# -------------------------------------------------------------------- LoRA

@app.get("/api/lora/list")
async def lora_list() -> Dict[str, Any]:
    """Every LoRA a workflow can reference.

    `list_lora_names` asks ComfyUI rather than scanning a folder, which is what
    makes a library on another drive show up. Scanning `ComfyUI/models/loras`
    directly - v3 did this in one place - reports none of it.
    """
    return {"loras": lora_service.list_lora_names()}


@app.get("/api/lora/installed")
async def lora_installed() -> Dict[str, Any]:
    return {"installed": lora_service.get_installed()}


# ------------------------------------------------------------------- files

@app.get("/api/files/list")
async def files_list(limit: int = 100) -> Dict[str, Any]:
    """Recent output files, newest first."""
    if not OUTPUT_DIR.exists():
        return {"files": []}
    allowed = {".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm"}
    found = [p for p in OUTPUT_DIR.rglob("*")
             if p.is_file() and p.suffix.lower() in allowed]
    found.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    files = []
    for path in found[:limit]:
        rel = path.relative_to(OUTPUT_DIR).as_posix()
        subfolder = str(Path(rel).parent).replace("\\", "/")
        files.append({
            "filename": path.name,
            "subfolder": "" if subfolder == "." else subfolder,
            "modified": path.stat().st_mtime,
            "size": path.stat().st_size,
            "url": f"{COMFY_URL}/view?filename={path.name}"
                   f"&subfolder={'' if subfolder == '.' else subfolder}&type=output",
        })
    return {"files": files}


class DeleteRequest(BaseModel):
    filename: str
    subfolder: str = ""


@app.post("/api/files/delete")
async def files_delete(req: DeleteRequest) -> Dict[str, Any]:
    # Resolve inside the output tree and check afterwards, so a filename
    # carrying `..` cannot walk out of it.
    target = (OUTPUT_DIR / req.subfolder / req.filename).resolve()
    if not str(target).startswith(str(OUTPUT_DIR.resolve())):
        raise HTTPException(status_code=400, detail="Path outside the output folder")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="No such file")
    target.unlink()
    return {"success": True}


# ------------------------------------------------------------------ ComfyUI

# run.ps1 owns the ComfyUI process, so it is the only thing that can stop and
# start it. A file is how this asks: the launcher's output loop is already
# running and checks for it between reads.
RESTART_FLAG = ROOT_DIR / "logs" / "restart_comfy.flag"


@app.post("/api/comfy/restart")
def comfy_restart() -> Dict[str, Any]:
    """Stop ComfyUI and start it again, and report what actually happened.

    The previous version posted to ComfyUI's /shutdown, which does not exist -
    ComfyUI has no such route. A 404 is not an exception for requests.post, so
    nothing was caught, nothing stopped, and the poll that followed reached a
    ComfyUI that had never gone away. The button reported a successful restart
    every time while doing nothing at all, which is worse than not having it.

    Nor could it have worked: run.ps1 had no way to bring ComfyUI back, so a
    shutdown that succeeded would have left it down until the whole app was
    restarted by hand.

    Sync rather than async - it waits the better part of a minute, and as a
    coroutine that would freeze every other request in the app.
    """
    try:
        RESTART_FLAG.parent.mkdir(parents=True, exist_ok=True)
        RESTART_FLAG.write_text("restart", encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500,
                            detail=f"Could not ask the launcher to restart: {exc}")

    # Down first, then up. Waiting only for "up" would see the old process
    # still answering and call it done before anything had happened.
    def answering() -> bool:
        try:
            requests.get(f"{COMFY_URL}/system_stats", timeout=1)
            return True
        except requests.RequestException:
            return False

    went_down = False
    for _ in range(40):                       # 20s to notice and stop
        if not answering():
            went_down = True
            break
        time.sleep(0.5)
    if not went_down:
        # The flag is left in place: the launcher may still be between reads,
        # and deleting it here would cancel a restart that is about to happen.
        return {"success": False, "restarted": False,
                "detail": "The launcher did not pick this up. Restart FEDDA to apply the change."}

    for _ in range(160):                      # 80s to come back; it loads models
        time.sleep(0.5)
        if answering():
            return {"success": True, "restarted": True}
    return {"success": True, "restarted": False,
            "detail": "ComfyUI stopped and is still starting."}


@app.post("/api/comfy/refresh-models")
async def comfy_refresh_models() -> Dict[str, Any]:
    lora_service.refresh_cache()
    try:
        response = requests.post(f"{COMFY_URL}/api/models/refresh", timeout=10)
        return {"success": response.ok}
    except requests.RequestException as exc:
        return {"success": False, "detail": str(exc)}




# ---------------------------------------------------------------- ollama
#
# Optional, and deliberately so. Ollama is a separate program with models of
# its own - a text model is several gigabytes on top of the twenty this app
# already asks for - and none of it is needed to make a picture. So nothing
# installs it and nothing starts it here: if it answers on 11434 the prompt
# box grows a button, and if it does not, the app is unchanged.
#
# v3 grew seven endpoints here, including a prompt enhancer with per-model
# recipes, a brief generator and per-model sampling tweaks. Two are
# carried: which models exist, and turn this prompt into a better one.

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")

# Preference order for the writing model, best first. Falls back to whatever
# is installed, because a machine with one model should still work.
OLLAMA_PREFERRED = ("llama3.1", "llama3", "qwen2.5", "mistral", "gemma2")


def _ollama_models() -> List[str]:
    try:
        resp = requests.get(f"{OLLAMA_URL}/api/tags", timeout=3)
        if not resp.ok:
            return []
        return [m["name"] for m in resp.json().get("models", []) if m.get("name")]
    except requests.RequestException:
        return []


def _ollama_text_model(models: Optional[List[str]] = None) -> Optional[str]:
    """The model to write with. Vision models are skipped - they answer about
    a picture rather than describing one that does not exist yet."""
    names = models if models is not None else _ollama_models()
    usable = [n for n in names if not any(v in n.lower() for v in ("llava", "vision", "-vl"))]
    for want in OLLAMA_PREFERRED:
        for name in usable:
            if name.lower().startswith(want):
                return name
    return usable[0] if usable else None


@app.get("/api/ollama/models")
async def ollama_models() -> Dict[str, Any]:
    models = _ollama_models()
    return {
        "online": bool(models),
        "models": models,
        "text_model": _ollama_text_model(models),
    }


class PromptHelpRequest(BaseModel):
    prompt: str = ""
    workflow_id: str = ""
    model: str = ""


# Two jobs, and they want different things said. An image prompt describes one
# frame; a video prompt has to carry motion, a camera, and - for MiniMax H3,
# which generates sound in the same pass - what the shot sounds like. Asking
# for one and getting the other is worse than asking for nothing.
_IMAGE_RULES = (
    "You expand short image prompts into detailed ones for a text-to-image model.\n"
    "Describe one still frame: subject, what they look like, what they are doing, "
    "the setting, the light, the lens and the mood.\n"
    "Keep every specific the user gave. Add detail, never contradict them.\n"
    "Reply with the prompt itself and nothing else - no preamble, no quotes, "
    "no explanation. Under 120 words."
)
_VIDEO_RULES = (
    "You expand short prompts into detailed ones for a text-to-video model that "
    "generates picture and sound together.\n"
    "Describe the shot over time: what moves, how the camera moves, and how it "
    "changes from the first second to the last.\n"
    "Then describe what it sounds like - the room, the sound effects, any music. "
    "The model renders audio from this, so silence about sound produces silence.\n"
    "Keep every specific the user gave. Add detail, never contradict them.\n"
    "Reply with the prompt itself and nothing else. Under 160 words."
)


@app.post("/api/ollama/prompt")
async def ollama_prompt(req: PromptHelpRequest) -> Dict[str, Any]:
    model = req.model or _ollama_text_model()
    if not model:
        raise HTTPException(status_code=503,
                            detail=f"No Ollama model answered on {OLLAMA_URL}")

    seed = (req.prompt or "").strip()
    if not seed:
        raise HTTPException(status_code=400, detail="Nothing to expand")

    # Whether this workflow makes a video is already known - the schema says
    # so, from the graph - rather than guessed from the workflow's name.
    makes_video = False
    try:
        makes_video = descriptor.describes_video(req.workflow_id)
    except Exception:
        pass

    try:
        resp = requests.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": model,
                "stream": False,
                "options": {"temperature": 0.6},
                "messages": [
                    {"role": "system",
                     "content": _VIDEO_RULES if makes_video else _IMAGE_RULES},
                    {"role": "user", "content": seed},
                ],
            },
            timeout=120,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=503, detail=f"Ollama did not answer: {exc}")

    if not resp.ok:
        raise HTTPException(status_code=502, detail=f"Ollama refused: {resp.text[:200]}")

    text = ((resp.json().get("message") or {}).get("content") or "").strip()
    if not text:
        raise HTTPException(status_code=502, detail="Ollama returned nothing")
    return {"prompt": text, "model": model, "kind": "video" if makes_video else "image"}


# Last in the file, and it has to stay last. uvicorn.run blocks, so every
# route defined below this point is never registered when the app is
# started - the Ollama endpoints sat here for a while and answered 404 on a
# real launch while passing every in-process test, because importing the
# module skips this block entirely and registers them fine.
if __name__ == "__main__":
    import uvicorn

    # No reload. It doubles the process, and `object_info.cache.json` is read
    # once at import - a reloader would load several megabytes twice per edit.
    print("[FEDDA Hub v4] backend on http://127.0.0.1:8000")
    # log_config=None so uvicorn keeps the logging setup_logging built.
    # Its default config runs dictConfig at startup, which replaces the
    # handlers and levels chosen above - the polling filter went on before
    # that and was thrown away with them, and the console filled up again.
    uvicorn.run(app, host="127.0.0.1", port=8000,
                log_level="info", log_config=None)
