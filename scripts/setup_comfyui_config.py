"""
Configure ComfyUI defaults used by FEDDA.
1) ComfyUI-Manager: keep permissive node install policy.
2) ComfyUI user settings: enforce preview-friendly defaults.
"""
import json
from pathlib import Path
import configparser


def _resolve_comfy_dir() -> Path:
    return Path(__file__).parent.parent / "ComfyUI"


def setup_comfyui_manager_config(comfy_dir: Path) -> None:
    """Configure ComfyUI-Manager defaults."""
    config_dir = comfy_dir / "user" / "__manager"
    config_file = config_dir / "config.ini"
    config_dir.mkdir(parents=True, exist_ok=True)

    config = configparser.ConfigParser()
    if config_file.exists():
        config.read(config_file)

    if "default" not in config:
        config["default"] = {}

    section = config["default"]
    section["security_level"] = "weak"
    section["preview_method"] = "auto"
    section["file_logging"] = "True"
    section["component_policy"] = "mine"
    section["update_policy"] = "stable-comfyui"
    section["always_lazy_install"] = "False"

    with open(config_file, "w", encoding="utf-8") as f:
        config.write(f)

    print(f"[OK] ComfyUI Manager config updated: {config_file}")


def setup_comfyui_preview_defaults(comfy_dir: Path) -> None:
    """Set Comfy UI preview defaults in user settings."""
    settings_path = comfy_dir / "user" / "default" / "comfy.settings.json"
    settings_path.parent.mkdir(parents=True, exist_ok=True)

    data = {}
    if settings_path.exists():
        try:
            data = json.loads(settings_path.read_text(encoding="utf-8"))
        except Exception:
            data = {}

    # Ensure live previews are available by default in UI.
    data["Comfy.Execution.PreviewMethod"] = "auto"
    # VHS advanced previews should always emit when available.
    data["VHS.AdvancedPreviews"] = "Always"

    settings_path.write_text(json.dumps(data, ensure_ascii=False, indent=4), encoding="utf-8")
    print(f"[OK] Comfy user settings updated: {settings_path}")


if __name__ == "__main__":
    comfy = _resolve_comfy_dir()
    setup_comfyui_manager_config(comfy)
    setup_comfyui_preview_defaults(comfy)
    print("   Preview defaults set (Execution=auto, VHS=Always)")
