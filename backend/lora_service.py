"""
LoRA Service — catalog browsing, download tracking, install scanning.

Packs are sourced from public HuggingFace dataset repos (pmczip).
Catalog is cached for 10 minutes so browsing is snappy.
Preview images: prefers /lora-previews/<pack_key>/<Basename>.jpg stored in GitHub,
falls back to the HuggingFace-hosted image if not present locally.
"""

import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional
import re
import json
from urllib.request import Request, urlopen
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import requests


def _normalize_lora_path(path: str) -> str:
    """Normalize a LoRA path for reliable prefix/family comparison.
    - Converts Windows backslashes to forward slashes
    - Lowercases (Windows filesystem is case-insensitive)
    - Strips leading/trailing whitespace and slashes
    """
    if not path:
        return ""
    p = str(path).replace("\\", "/").strip().lower()
    return p.strip("/")


def _is_link(path: Any) -> bool:
    """True if path is a symlink OR a Windows junction/reparse point.

    os.path.islink() alone is not enough on Windows: a junction is
    IO_REPARSE_TAG_MOUNT_POINT, not IO_REPARSE_TAG_SYMLINK, so islink() returns
    False for it. st_reparse_tag (Windows, py3.8+) catches both; on POSIX the
    attribute is absent and islink() is authoritative.
    """
    try:
        if os.path.islink(path):
            return True
        return getattr(os.lstat(path), "st_reparse_tag", 0) != 0
    except OSError:
        return False


# ─── Pack Registry ─────────────────────────────────────────────────────────────
# hf_type: "dataset" or "model" — determines which HF API endpoint to use
# img_subfolder: optional subfolder within the HF repo where preview .jpg images live
PACKS: Dict[str, Dict[str, str]] = {
    "zimage_turbo": {
        "hf_repo":        "pmczip/Z-Image-Turbo_Models",
        "hf_type":        "model",
        "dest":           "zimage_turbo",
        "img_subfolder":  "ZIT_Images",
    },
    "zimage_nsfw": {
        "hf_repo":       "qqnyanddld/nsfw-z-image-lora",
        "hf_type":       "model",
        "dest":          "zimage_turbo",
    },
    "wan22_nsfw": {
        "hf_repo":       "lkzd7/WAN2.2_LoraSet_NSFW",
        "hf_type":       "model",
        "dest":          "wan22",
    },
    "flux2klein": {
        "hf_repo":       "pmczip/FLUX.2-klein-9B_Models",
        "hf_type":       "model",
        "dest":          "flux2klein",
        "img_subfolder": "klein_images",
    },
    "flux1dev": {
        "hf_repo":       "pmczip/FLUX.1-dev_Models",
        "hf_type":       "model",
        "dest":          "flux1dev",
        "img_subfolder": "Flux1D_Images",
    },
    # Body and realism LoRAs for FLUX.1 - sliders, anatomy, skin texture - which
    # flux1dev does not carry: that pack is entirely likeness LoRAs. Kept in a
    # subfolder of its repository, which is what `src` is for.
    "flux1dev_body": {
        "hf_repo":       "hvai/flux",
        "hf_type":       "dataset",
        "src":           "lorra_flux",
        "dest":          "flux1dev",
    },
    "flux2klein_realism_engine": {
        "dest": "flux2klein",
        "static_items": [
            {
                "name": "Realism Engine Klein",
                "file": "realism-engine-klein.safetensors",
                "url":  "https://civitai.red/api/download/models/2679241?type=Model&format=SafeTensor",
            }
        ],
    },
    # Not a LoRA: a Z-Image Turbo checkpoint, so it needs models/unet and no
    # subfolder - UNETLoader only lists what sits directly in that root.
    "zimage_redzit2": {
        "root": "unet",
        "static_items": [
            {
                "name": "RedZiT2 2026HD (int8 convrot)",
                "file": "redcraftMinimaxH3REDMIX_redzit222026HD.safetensors",
                "url":  "https://civitai.com/api/download/models/3100874?fileId=2980681",
                "size_mb": 6850,
            }
        ],
    },
    "sd15": {
        "hf_repo":  "pmczip/SD1.5_LoRa_Models",
        "hf_type":  "model",
        "dest":     "sd15",
    },
    "sd15_lycoris": {
        "hf_repo":       "pmczip/SD1.5_LyCORIS_Models",
        "hf_type":       "model",
        "dest":          "sd15-lycoris",
        "img_subfolder": "LYCORIS_Images",
    },
    "sdxl": {
        "hf_repo":       "pmczip/SDXL_Models",
        "hf_type":       "model",
        "dest":          "sdxl",
        "img_subfolder": "SDXL_Images",
    },
}

# The starter LoRAs that ship with the app, from the public FeddaKalkun/free-loras
# dataset. The URLs must match the repo's actual layout: the files live in a
# folder per character and are capitalised there, so the flat lowercase paths
# this list used to carry 404'd on every install. Verified anonymously - no HF
# token needed, which is the point of a starter pack.
FREE_LORAS = [
    {
        "id":       "emmy",
        "name":     "Emmy",
        "filename": "emmy.safetensors",
        "url":      "https://huggingface.co/datasets/FeddaKalkun/free-loras/resolve/main/Emmy/Emmy.safetensors",
    },
    {
        # Displayed as Zana; the id and filename stay "sana" because that is
        # what the file is actually called in the dataset. Renaming those would
        # break the download for a cosmetic change.
        "id":       "sana",
        "name":     "Zana",
        "filename": "sana.safetensors",
        "url":      "https://huggingface.co/datasets/FeddaKalkun/free-loras/resolve/main/Sana/sana.safetensors",
    },
    {
        "id":       "maya",
        "name":     "Maya",
        "filename": "maya.safetensors",
        "url":      "https://huggingface.co/datasets/FeddaKalkun/free-loras/resolve/main/Maya/Maya-Sol.safetensors",
    },
]


class LoRAService:
    def __init__(self, root_dir: Path):
        self.root        = root_dir
        self.lora_dir    = root_dir / "ComfyUI" / "models" / "loras"
        # GitHub-stored previews live under frontend/public
        self.preview_dir = root_dir / "frontend" / "public" / "lora-previews"

        # HF catalog cache: pack_key → (fetch_timestamp, [hf_file_items])
        self._catalog_cache: Dict[str, tuple] = {}
        self._cache_ttl = 600  # 10 minutes

        # Download state: filename → { status, progress, pack_key?, error? }
        self._downloads: Dict[str, Dict[str, Any]] = {}
        # Import jobs: job_id → { status, progress, filename, message? }
        self._import_jobs: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    def refresh_cache(self):
        """Force clear any caches so new local files appear immediately."""
        self._catalog_cache.clear()

    def get_dest_for_family(self, family: str) -> Optional[str]:
        """Returns the destination subfolder for a given family/tab."""
        # Map UI family names to pack keys that have a 'dest'
        family_to_pack: Dict[str, str] = {
            "z-image": "zimage_turbo",
            "flux2klein": "flux2klein",
            "sd15": "sd15",
            "sdxl": "sdxl",
            "wan": "wan22_nsfw",
        }

        pack_key = family_to_pack.get(family, family)

        if pack_key in PACKS:
            return PACKS[pack_key].get("dest", pack_key)

        # Fallback: use the family name as folder
        return family

    # ─── Runtime token helpers ─────────────────────────────────────────────

    def _load_runtime_settings(self) -> Dict[str, Any]:
        settings_path = self.root / "config" / "runtime_settings.json"
        try:
            if settings_path.exists():
                import json
                return json.loads(settings_path.read_text(encoding="utf-8"))
        except Exception:
            pass
        return {}

    def _resolve_download_url(
        self,
        url: str,
        hf_token: Optional[str] = None,
        civitai_token: Optional[str] = None,
    ) -> str:
        """
        Resolve provider-specific URL auth, similar to HF token auto-injection.
        - Civitai: append ?token=<key> when URL host is civitai and token is missing.
        """
        parsed = urlparse(url)
        host = (parsed.netloc or "").lower()

        if "civitai.com" in host or "civitai.red" in host:
            token = (civitai_token or "").strip()
            if not token:
                settings = self._load_runtime_settings()
                token = str(settings.get("civitai_api_key") or "").strip()
            if token:
                q = dict(parse_qsl(parsed.query, keep_blank_values=True))
                if "token" not in q:
                    q["token"] = token
                    return urlunparse(parsed._replace(query=urlencode(q, doseq=True)))

        return url

    def _hf_token(self, hf_token: Optional[str] = None) -> str:
        """Explicit token, else the one saved in settings.

        Without this fallback a token saved via the UI is never applied, so gated
        repos fail with an empty catalog / 401 even though the key is configured.
        """
        token = (hf_token or "").strip()
        if token:
            return token
        return str(self._load_runtime_settings().get("hf_token") or "").strip()

    def _hf_headers(self, hf_token: Optional[str] = None, url: str = "") -> Dict[str, str]:
        """Auth headers for a download, empty for anywhere that is not HuggingFace.

        Sending the HF bearer token to Civitai made it reject the request with
        401 even though the correct `?token=` was already on the URL - it sees a
        bearer token it does not recognise and refuses. Public files still came
        down, since those are never checked, which is why only the gated LoRAs
        appeared to fail.
        """
        if url and "huggingface.co" not in urlparse(url).netloc.lower():
            return {}
        token = self._hf_token(hf_token)
        return {"Authorization": f"Bearer {token}"} if token else {}

    # ─── HuggingFace helpers ────────────────────────────────────────────────

    def _hf_file_url(self, pack_key: str, filename: str) -> str:
        pack = PACKS[pack_key]
        for item in pack.get("static_items", []):
            if item.get("file") == filename:
                return item.get("url", "")

        repo = pack["hf_repo"]
        src = pack.get("src", "").strip("/")
        path = f"{src}/{filename}" if src else filename
        if pack["hf_type"] == "dataset":
            return f"https://huggingface.co/datasets/{repo}/resolve/main/{path}"
        return f"https://huggingface.co/{repo}/resolve/main/{path}"

    # ─── Installed-LoRA previews ────────────────────────────────────────────

    PREVIEW_EXTS = (".preview.jpg", ".preview.png", ".jpg", ".png")

    def _preview_cache_path(self, rel: str) -> Path:
        """Cache location for LoRAs we cannot write a sidecar next to.

        Linked stashes are frequently read-only (or on another volume), so the
        sidecar convention can't be the only option. Hashed on the normalized
        relative path so two same-named LoRAs in different folders don't collide.
        """
        import hashlib
        digest = hashlib.sha1(_normalize_lora_path(rel).encode("utf-8")).hexdigest()
        return self.root / "config" / "lora_previews" / f"{digest}.jpg"

    def _lora_fs_path(self, rel: str) -> Path:
        """Relative LoRA path -> real filesystem path.

        Deliberately does NOT use _normalize_lora_path: that lowercases (it exists
        for case-insensitive KEY comparison). Lowercasing a real path is harmless
        on Windows but breaks on Linux — which is where the RunPod image runs.
        """
        return self.lora_dir / str(rel).replace("\\", os.sep).replace("/", os.sep).strip(os.sep)

    def preview_file_for(self, rel: str) -> Optional[Path]:
        """Resolve an on-disk preview image for an installed LoRA, or None.

        Order: sidecar next to the LoRA (mirrors the existing <stem>.md sheet
        convention and travels with a linked folder) -> hashed cache -> None.
        """
        lora = self._lora_fs_path(rel)
        stem = str(lora.with_suffix(""))          # .../foo.safetensors -> .../foo
        for ext in self.PREVIEW_EXTS:             # foo.preview.jpg, foo.png, ...
            try:
                cand = Path(stem + ext)
                if cand.is_file():
                    return cand
            except OSError:
                pass
        cached = self._preview_cache_path(rel)
        try:
            if cached.is_file():
                return cached
        except OSError:
            pass
        return None

    def save_preview_for(self, rel: str, data: bytes) -> Dict[str, Any]:
        """Write a preview for an installed LoRA.

        Prefers a sidecar so it stays with the file; falls back to the cache when
        the folder isn't writable (read-only or linked external stash).
        """
        lora = self._lora_fs_path(rel)
        sidecar = Path(str(lora.with_suffix("")) + ".preview.jpg")
        try:
            sidecar.write_bytes(data)
            return {"success": True, "stored": "sidecar", "path": str(sidecar)}
        except OSError:
            cached = self._preview_cache_path(rel)
            try:
                cached.parent.mkdir(parents=True, exist_ok=True)
                cached.write_bytes(data)
                return {"success": True, "stored": "cache", "path": str(cached)}
            except OSError as exc:
                return {"success": False, "error": str(exc)}

    def _preview_url(self, pack_key: str, basename: str) -> Optional[str]:
        """
        Returns the best available preview URL.
        Priority: GitHub-stored static image (.png or .jpg) > HuggingFace subfolder > None.
        """
        for ext in (".png", ".jpg"):
            static = self.preview_dir / pack_key / f"{basename}{ext}"
            if static.exists():
                return f"/lora-previews/{pack_key}/{basename}{ext}"

        pack = PACKS.get(pack_key)
        if not pack:
            return None
        repo = pack["hf_repo"]
        img_subfolder = pack.get("img_subfolder", "")
        img_path = f"{img_subfolder}/{basename}.png" if img_subfolder else f"{basename}.png"
        if pack["hf_type"] == "dataset":
            return f"https://huggingface.co/datasets/{repo}/resolve/main/{img_path}"
        return f"https://huggingface.co/{repo}/resolve/main/{img_path}"

    def _fetch_hf_catalog(self, pack_key: str) -> List[Dict[str, Any]]:
        """Fetch file listing from HuggingFace with cache."""
        pack = PACKS.get(pack_key)
        if not pack:
            return []
        if pack.get("static_items"):
            return []

        now = time.time()
        cached = self._catalog_cache.get(pack_key)
        if cached and (now - cached[0]) < self._cache_ttl:
            return cached[1]

        repo     = pack["hf_repo"]
        hf_type  = pack["hf_type"]
        src      = pack.get("src", "").strip("/")
        api_url  = (
            f"https://huggingface.co/api/datasets/{repo}/tree/main"
            if hf_type == "dataset"
            else f"https://huggingface.co/api/models/{repo}/tree/main"
        )
        if src:
            api_url = f"{api_url}/{src}"

        try:
            resp = requests.get(api_url, timeout=15, headers=self._hf_headers())
            resp.raise_for_status()
            items = resp.json()
            safetensors = [
                item for item in items
                if isinstance(item, dict) and item.get("path", "").lower().endswith(".safetensors")
            ]
            self._catalog_cache[pack_key] = (now, safetensors)
            return safetensors
        except Exception as exc:
            print(f"[LoRAService] HF fetch failed for '{pack_key}': {exc}")
            # Return stale data if available rather than nothing
            return self._catalog_cache.get(pack_key, (0, []))[1]

    # ─── Install scanning ───────────────────────────────────────────────────

    def get_installed(self) -> Dict[str, Any]:
        """Recursively scan the loras directory and return {normalized_rel_path: info}.

        Keyed by normalized relative path, NOT bare filename: the same filename
        legitimately exists in several folders (e.g. lightx2v_* lives in both the
        root and wan/), and bare-name keys silently dropped all but the last.

        info["path"] keeps the native relative path verbatim — it is what ComfyUI
        expects and what every workflow's LoRA dropdown stores. Do not normalize it.

        Junction/symlink-loop safe: users link external LoRA stashes into the
        loras dir (symlink_modelfolder.bat), and a bad link can create an infinite
        directory cycle that made pathlib.rglob crash with WinError 1921.
        We walk manually and prune any directory whose real path was already
        visited."""
        result: Dict[str, Any] = {}
        if not self.lora_dir.exists():
            return result
        seen_real: set = set()
        for root, dirs, files in os.walk(self.lora_dir):
            try:
                real = os.path.realpath(root)
            except OSError:
                dirs[:] = []
                continue
            if real in seen_real:
                dirs[:] = []  # loop detected - do not descend
                continue
            seen_real.add(real)
            for name in files:
                if not name.lower().endswith(".safetensors"):
                    continue
                f = Path(root) / name
                try:
                    rel = str(f.relative_to(self.lora_dir))
                    st = f.stat()
                    parent = str(Path(rel).parent)
                    result[_normalize_lora_path(rel)] = {
                        "path":    rel,
                        "name":    f.name,
                        # Forward slashes for consistency, but case preserved: this
                        # is used as a display name and to build real paths, and
                        # Linux (RunPod) is case-sensitive.
                        "folder":  parent.replace("\\", "/") if parent != "." else "",
                        "size_mb": round(st.st_size / (1024 * 1024), 1),
                        "mtime":   st.st_mtime,
                        "is_link": _is_link(f),
                    }
                except Exception:
                    pass
        return result

    def list_lora_names(self) -> List[str]:
        """Every LoRA a workflow can reference, as ComfyUI would name it.

        Asks ComfyUI rather than scanning a folder. `self.lora_dir` is the
        install's own `ComfyUI/models/loras`, and extra_model_paths.yaml can
        point at any number of roots besides it - a library on another drive is
        the normal case, not the exception. Scanning one directory therefore
        reported none of it: ComfyUI offered 987 names while this returned an
        empty list, and the picker said "Search 0 LoRAs..." on a machine full of
        them.

        Same reasoning as comfy_output_types() in workflow_service: the question
        is "what does ComfyUI have", so ask ComfyUI. Only it has resolved every
        search path.

        The folder walk remains the fallback, because the server can be asked
        this before ComfyUI has finished starting.
        """
        try:
            with urlopen("http://127.0.0.1:8199/object_info/LoraLoader", timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8", errors="ignore"))
            names = (data.get("LoraLoader", {})
                         .get("input", {})
                         .get("required", {})
                         .get("lora_name", [[]])[0])
            if names:
                return list(names)
        except Exception:                              # noqa: BLE001 - fall back, never fail
            pass

        return [info["path"] for info in self.get_installed().values()]

    # ─── Characters ─────────────────────────────────────────────────────────

    @staticmethod
    def _sheet_claimed_loras(sheet_path) -> List[str]:
        """Paths a sheet claims, from a `loras:` list in its front matter.

        Deliberately not a YAML parse: the sheets are hand-written prose with a
        small header, adding a dependency to read six lines would be a poor
        trade, and a strict parser turns a typo into an exception instead of a
        skipped line. Reads until the list stops looking like a list.

            ---
            name: Sara
            loras:
              - krea2/sara-krea-060825.safetensors
              - zimage_turbo/Sara_zimage1.safetensors
            ---
        """
        try:
            text = sheet_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return []

        claimed: List[str] = []
        in_list = False
        for raw in text.splitlines():
            line = raw.rstrip()
            if not in_list:
                if line.strip().lower().startswith("loras:"):
                    in_list = True
                continue
            stripped = line.strip()
            # A dash and then a value.  closes the front matter and is not
            # an item: startswith("-") alone read it as one and claimed "--".
            if stripped.startswith("- "):
                value = stripped[1:].strip().strip("\"'")
                if value:
                    claimed.append(value.replace("\\", "/"))
                continue
            # Anything that is not a list item ends the list, including the
            # closing --- and a blank line.
            break
        return claimed

    def get_characters(self) -> List[Dict[str, Any]]:
        """Group installed LoRAs into characters.

        A character is a folder of LoRAs that belong to one person, usually across
        several model families (one character = a krea2 LoRA + a z-image one) sharing a
        single .md sheet.

        Detection is a union of two rules, because neither covers everything:

        - **a lone .md**: a folder holding exactly one .md plus at least one
          .safetensors. This is the portable rule — it describes itself, so it
          works whatever a user names their folders. But it only finds characters
          that actually have a sheet (8 of 20 here).
        - **under app/**: the existing convention in this install. Structurally
          `app/character_k/` (a character) and `qwen/` (a family folder) are identical —
          both are just folders of .safetensors — so without a sheet, the `app/`
          parent is the only signal that Emily is a person. Keeps the other 12.

        The loras root is never a character: it has 57 .safetensors and 2 .md that
        belong to individual LoRAs, and would otherwise collapse into one giant
        bogus character.
        """
        installed = self.get_installed()

        by_folder: Dict[str, List[Dict[str, Any]]] = {}
        for info in installed.values():
            folder = info.get("folder") or ""
            if not folder:
                continue  # root LoRAs are never characters
            by_folder.setdefault(folder, []).append(info)

        # characters/<Name> folders exist as soon as the sheet is written, and
        # may hold no LoRAs directly - they live in the family folders below.
        try:
            croot = self._lora_fs_path("characters")
            if croot.is_dir():
                for child in croot.iterdir():
                    if child.is_dir():
                        by_folder.setdefault("characters/" + child.name, [])
        except OSError:
            pass

        # A character whose LoRAs all live elsewhere. Since a sheet can claim
        # paths from any folder, a person can exist with an empty folder and a
        # sheet naming weights under zimage_turbo/ or wan22/ - and that folder
        # holds no LoRAs, so the loop above never sees it.
        #
        # Restricted to app/, which is already the convention for "this folder
        # is a person": the same rule applied everywhere would turn any folder
        # that happens to contain a markdown file into a character.
        try:
            app_dir = self._lora_fs_path("app")
            if app_dir.is_dir():
                for child in app_dir.iterdir():
                    if not child.is_dir():
                        continue
                    key = "app/" + child.name
                    if key in by_folder:
                        continue
                    if any(p.is_file() for p in child.glob("*.md")):
                        by_folder[key] = []
        except OSError:
            pass

        characters: List[Dict[str, Any]] = []
        for folder, loras in by_folder.items():
            fs_dir = self._lora_fs_path(folder)
            try:
                mds = [p for p in fs_dir.glob("*.md") if p.is_file()]
            except OSError:
                mds = []

            # Direct child of app/ only: `app/<character>/New folder` holds 10 loose LoRAs
            # and is not a person — a bare startswith would name a character
            # "New folder".
            parts = folder.split("/")
            under_app = len(parts) == 2 and parts[0].lower() == "app"
            has_lone_sheet = len(mds) == 1

            # characters/<Name>/... — the layout LoRAs are being moved into. The
            # name folder carries the sheet and no weights; the family folders
            # beneath it carry weights and no sheet, so neither rule above sees
            # one. Anything under the name folder belongs to that person, which
            # is what lets the family level be organisation rather than meaning.
            under_characters = len(parts) >= 2 and parts[0].lower() == "characters"
            if under_characters and len(parts) > 2:
                continue  # counted under its character, not as one of its own

            if not (under_app or under_characters or has_lone_sheet):
                continue

            sheet = mds[0] if has_lone_sheet else None

            # LoRAs the sheet claims from elsewhere. Matched on the normalised
            # path because ComfyUI reports separators per folder, not per
            # platform - see the note in CLAUDE.md.
            owned = list(loras)
            if folder.split("/")[0].lower() == "characters":
                prefix = folder.lower() + "/"
                owned = [
                    i for i in installed.values()
                    if (i.get("path") or "").replace("\\", "/").lower().startswith(prefix)
                ]

            missing: List[str] = []
            if sheet:
                have = {(l.get("path") or "").replace("\\", "/").lower() for l in owned}
                by_path = {
                    (i.get("path") or "").replace("\\", "/").lower(): i
                    for i in installed.values()
                }
                for claim in self._sheet_claimed_loras(sheet):
                    key = claim.lower()
                    if key in have:
                        continue
                    found = by_path.get(key)
                    if found:
                        owned.append(found)
                        have.add(key)
                    else:
                        missing.append(claim)

            characters.append({
                "name": folder.split("/")[-1],
                "folder": folder,
                "sheet": str(sheet.relative_to(self.lora_dir)) if sheet else None,
                "has_sheet": sheet is not None,
                # Named rather than dropped: a claim that does not resolve is
                # what someone needs telling, and a quietly shorter list reads
                # as a missing LoRA rather than a typo in the sheet.
                "missing_claims": missing,
                "loras": sorted(
                    ({"path": l["path"], "file": l["name"], "size_mb": l["size_mb"]} for l in owned),
                    key=lambda x: x["file"].lower(),
                ),
            })

        return sorted(characters, key=lambda c: c["name"].lower())

    # ─── Pack catalog & status ──────────────────────────────────────────────

    def get_pack_catalog(self, pack_key: str, limit: int = 1000) -> Dict[str, Any]:
        if pack_key not in PACKS:
            return {"success": False, "error": "Unknown pack"}

        pack = PACKS[pack_key]
        installed = self.get_installed()

        items: List[Dict[str, Any]] = []
        dest_subfolder = pack.get("dest", "") or ""

        if pack.get("static_items"):
            for item in pack.get("static_items", [])[:limit]:
                raw_file = item.get("file", "")
                if not raw_file:
                    continue
                # Ensure the file field includes the correct subfolder for this pack
                filename = f"{dest_subfolder}/{raw_file}" if dest_subfolder and not raw_file.startswith(dest_subfolder + "/") else raw_file
                basename = Path(raw_file).stem
                # A pack outside loras/ is not in the LoRA index, so asking that
                # index would report it missing forever and the button would
                # never stop offering a 6.7 GB download.
                is_installed = (
                    (self._pack_dir(pack) / raw_file).exists()
                    if pack.get("root")
                    else _normalize_lora_path(filename) in installed
                )
                items.append({
                    "name":        item.get("name") or basename.replace("_", " "),
                    "file":        filename,
                    "installed":   is_installed,
                    "size_mb":     item.get("size_mb"),
                    "preview_url": item.get("preview_url"),
                })
        else:
            hf_files = self._fetch_hf_catalog(pack_key)
            for hf_item in hf_files[:limit]:
                raw_name = Path(hf_item.get("path", "")).name
                if not raw_name:
                    continue
                # Prefix with the destination subfolder so the name matches what ComfyUI reports
                filename = f"{dest_subfolder}/{raw_name}" if dest_subfolder else raw_name
                basename = Path(raw_name).stem
                size_bytes = hf_item.get("size", 0)

                items.append({
                    "name":        basename.replace("_", " "),
                    "file":        filename,
                    "installed":   _normalize_lora_path(filename) in installed,
                    "size_mb":     round(size_bytes / (1024 * 1024), 1) if size_bytes else None,
                    "preview_url": self._preview_url(pack_key, basename),
                })

        # Installed first, then alphabetical
        items.sort(key=lambda x: (not x["installed"], x["name"].lower()))

        return {
            "success":   True,
            "pack_key":  pack_key,
            "total":     len(items),
            "installed": sum(1 for i in items if i["installed"]),
            "items":     items,
        }

    def get_pack_status(self, pack_key: str) -> Dict[str, Any]:
        if pack_key not in PACKS:
            return {"success": False, "error": "Unknown pack"}

        with self._lock:
            active = [
                fn for fn, d in self._downloads.items()
                if d.get("status") == "downloading" and d.get("pack_key") == pack_key
            ]

        catalog = self.get_pack_catalog(pack_key)
        return {
            "success":          True,
            "pack_key":         pack_key,
            "status":           "running" if active else "idle",
            "active_downloads": len(active),
            "installed":        catalog.get("installed", 0),
            "total":            catalog.get("total", 0),
        }

    # ─── Download helpers ───────────────────────────────────────────────────

    def get_download_status(self, filename: str) -> Dict[str, Any]:
        with self._lock:
            return dict(self._downloads.get(filename, {"status": "idle", "progress": 0}))

    def _do_download(
        self,
        url: str,
        dest: Path,
        filename: str,
        pack_key: Optional[str] = None,
        hf_token: Optional[str] = None,
        civitai_token: Optional[str] = None,
    ) -> None:
        with self._lock:
            self._downloads[filename] = {"status": "downloading", "progress": 0, "pack_key": pack_key}
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            headers = {}
            if hf_token:
                headers["Authorization"] = f"Bearer {hf_token}"

            resolved_url = self._resolve_download_url(url, hf_token=hf_token, civitai_token=civitai_token)
            resp = requests.get(resolved_url, stream=True, timeout=60, headers=headers)
            resp.raise_for_status()

            total      = int(resp.headers.get("content-length", 0))
            downloaded = 0

            with open(dest, "wb") as fh:
                for chunk in resp.iter_content(65536):
                    if chunk:
                        fh.write(chunk)
                        downloaded += len(chunk)
                        if total and downloaded % (1024 * 1024) < 65536:  # ~1 MB intervals
                            prog = int(downloaded / total * 100)
                            with self._lock:
                                self._downloads[filename]["progress"] = prog

            with self._lock:
                self._downloads[filename] = {"status": "completed", "progress": 100, "pack_key": pack_key}

        except Exception as exc:
            with self._lock:
                self._downloads[filename] = {"status": "error", "progress": 0, "error": str(exc), "pack_key": pack_key}
            if dest.exists():
                try:
                    dest.unlink()
                except Exception:
                    pass

    def _pack_dir(self, pack: Dict[str, Any]) -> Path:
        """Where a pack's files land.

        Everything here was a LoRA until a checkpoint needed the same plumbing -
        the Civitai token handling, the resume, the progress the Library already
        shows. A pack may now name a different root under ComfyUI/models;
        without one it stays in loras, so every existing pack is unaffected.
        A diffusion model dropped into loras/ is invisible to UNETLoader, which
        is the failure this avoids.
        """
        root = pack.get("root")
        base = (self.lora_dir.parent / root) if root else self.lora_dir
        return base / pack["dest"] if pack.get("dest") else base

    def download_single(self, pack_key: str, filename: str) -> Dict[str, Any]:
        if pack_key not in PACKS:
            return {"success": False, "error": "Unknown pack"}
        pack = PACKS[pack_key]
        dest = self._pack_dir(pack) / filename
        if dest.exists() and dest.stat().st_size > 10_000:
            return {"success": True, "status": "already_installed"}
        url = self._hf_file_url(pack_key, filename)
        if not url:
            return {"success": False, "error": "No download URL found for item"}
        threading.Thread(
            target=self._do_download,
            args=(url, dest, filename, pack_key),
            daemon=True,
        ).start()
        return {"success": True, "status": "started"}

    def sync_pack(self, pack_key: str) -> Dict[str, Any]:
        """Queue download of every file in a pack that isn't already installed."""
        if pack_key not in PACKS:
            return {"success": False, "error": "Unknown pack"}
        catalog  = self.get_pack_catalog(pack_key)
        pending  = [item for item in catalog.get("items", []) if not item["installed"]]
        pack     = PACKS[pack_key]

        def _task() -> None:
            for item in pending:
                dest = self._pack_dir(pack) / item["file"]
                url  = self._hf_file_url(pack_key, item["file"])
                if not url:
                    continue
                self._do_download(url, dest, item["file"], pack_key)

        threading.Thread(target=_task, daemon=True).start()
        return {"success": True, "queued": len(pending)}

    # ─── Free starter pack ──────────────────────────────────────────────────

    def install_free_lora(self, filename: str) -> Dict[str, Any]:
        lora = next((l for l in FREE_LORAS if l["filename"] == filename), None)
        if not lora:
            return {"success": False, "error": "Unknown free LoRA"}
        dest = self.lora_dir / "starter" / filename
        if dest.exists() and dest.stat().st_size > 10_000:
            return {"success": True, "status": "already_installed"}
        threading.Thread(
            target=self._do_download,
            args=(lora["url"], dest, filename, "starter"),
            daemon=True,
        ).start()
        return {"success": True, "status": "started"}

    def install_all_free(self) -> Dict[str, Any]:
        installed = self.get_installed()
        queued = 0
        for lora in FREE_LORAS:
            if lora["filename"] not in installed:
                self.install_free_lora(lora["filename"])
                queued += 1
        return {"success": True, "queued": queued}

    # ─── URL import ─────────────────────────────────────────────────────────

    _CIVITAI_DOWNLOAD = re.compile(r"/api/download/models/(\d+)")

    def _civitai_filename(self, url: str) -> Optional[str]:
        """The real filename behind a Civitai download URL, or None.

        A Civitai download link ends in the *version id*, so naming the file
        after the last path segment produced "2772932.safetensors" - which is
        what the LoRA picker then shows the user. The version API knows what the
        file is actually called, and one lookup is cheap next to the download.

        Any failure returns None so the caller keeps its old behaviour: a poor
        filename is much better than a failed import.
        """
        m = self._CIVITAI_DOWNLOAD.search(urlparse(url).path)
        if not m:
            return None
        try:
            req = Request(f"https://civitai.com/api/v1/model-versions/{m.group(1)}",
                          headers={"User-Agent": "FEDDA"})
            with urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception:
            return None
        for f in data.get("files") or []:
            name = str(f.get("name") or "")
            if name.endswith(".safetensors"):
                return name
        return None

    def _write_lora_meta(self, dest: Path, url: str) -> None:
        """Record what we know about an imported LoRA beside the file.

        Trigger words are the reason this exists. A prompt builder cannot insert
        them from a hardcoded table: the table would only ever describe the
        LoRAs on the machine it was written on, and every user has different
        ones. Captured at import, it works for LoRAs we have never seen.

        Civitai publishes `trainedWords` on the version record. HuggingFace has
        no equivalent field, so those get the repo recorded and no triggers -
        an honest empty list, rather than a guess. Failure is silent by design:
        losing the metadata is a worse outcome than losing the download.
        """
        meta: Dict[str, Any] = {"source_url": url, "trigger_words": []}
        # Enrichment is best-effort and the write is not: a lookup that fails
        # must still leave the source URL on disk, or nothing can ever fill the
        # rest in later. An earlier version wrapped both together and a single
        # timeout lost the file entirely.
        try:
            host = urlparse(url).netloc.lower()
            if "huggingface.co" in host:
                parts = urlparse(url).path.strip("/").split("/")
                if len(parts) >= 2:
                    meta["source"] = "huggingface"
                    meta["repo"] = f"{parts[0]}/{parts[1]}"
            else:
                m = self._CIVITAI_DOWNLOAD.search(urlparse(url).path)
                if m:
                    req = Request(f"https://civitai.com/api/v1/model-versions/{m.group(1)}",
                                  headers={"User-Agent": "FEDDA"})
                    with urlopen(req, timeout=20) as resp:
                        d = json.loads(resp.read().decode("utf-8"))
                    meta["source"] = "civitai"
                    meta["model_name"] = (d.get("model") or {}).get("name")
                    meta["version_name"] = d.get("name")
                    meta["base_model"] = d.get("baseModel")
                    meta["trigger_words"] = [w for w in (d.get("trainedWords") or []) if w]
        except Exception as exc:
            meta["lookup_error"] = str(exc)[:120]
        try:
            dest.with_suffix(dest.suffix + ".fedda.json").write_text(
                json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass

    def import_from_url(
        self,
        url: str,
        hf_token: Optional[str] = None,
        civitai_token: Optional[str] = None,
        dest_subfolder: str = "imported",
    ) -> Dict[str, Any]:
        raw_name = self._civitai_filename(url) or url.split("?")[0].split("/")[-1]
        filename = raw_name if raw_name.endswith(".safetensors") else raw_name + ".safetensors"
        job_id   = str(uuid.uuid4())[:8]
        subfolder = _normalize_lora_path(dest_subfolder) or "imported"
        dest     = self.lora_dir / subfolder / filename
        rel      = f"{subfolder}/{filename}"

        with self._lock:
            self._import_jobs[job_id] = {"status": "queued", "progress": 0, "filename": filename, "path": rel}

        def _task() -> None:
            with self._lock:
                self._import_jobs[job_id]["status"] = "downloading"
            # Download to a sidecar and only promote on a complete transfer, so an
            # interrupted import can never leave a truncated file that later looks
            # like a valid LoRA (same pattern as model_downloader.download_direct).
            tmp = dest.with_suffix(dest.suffix + ".fedda_tmp")
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                direct = url.replace("/blob/", "/resolve/") if "/blob/" in url else url
                direct = self._resolve_download_url(direct, hf_token=hf_token, civitai_token=civitai_token)
                headers = self._hf_headers(hf_token, direct)

                resp  = requests.get(direct, stream=True, timeout=60, headers=headers)
                resp.raise_for_status()
                total = int(resp.headers.get("content-length", 0))
                done  = 0

                with open(tmp, "wb") as fh:
                    for chunk in resp.iter_content(65536):
                        if chunk:
                            fh.write(chunk)
                            done += len(chunk)
                            if total and done % (1024 * 1024) < 65536:
                                with self._lock:
                                    self._import_jobs[job_id]["progress"] = int(done / total * 100)

                if total and done < total:
                    raise IOError(f"Download truncated: got {done} of {total} bytes")

                if dest.exists():
                    dest.unlink()
                tmp.rename(dest)

                self._write_lora_meta(dest, url)

                with self._lock:
                    self._import_jobs[job_id] = {
                        "status": "completed", "progress": 100, "filename": filename, "path": rel,
                    }

            except Exception as exc:
                with self._lock:
                    self._import_jobs[job_id] = {
                        "status": "error", "message": str(exc), "filename": filename, "path": rel,
                    }
                # Only the sidecar is ours to remove; never touch an existing dest.
                try:
                    if tmp.exists():
                        tmp.unlink()
                except OSError:
                    pass

        threading.Thread(target=_task, daemon=True).start()
        return {"success": True, "job_id": job_id, "filename": filename}

    def get_import_status(self, job_id: str) -> Dict[str, Any]:
        with self._lock:
            job = self._import_jobs.get(job_id)
        if not job:
            return {"success": False, "error": "Job not found"}
        return {"success": True, **job}


lora_service = LoRAService(Path(__file__).parent.parent)
