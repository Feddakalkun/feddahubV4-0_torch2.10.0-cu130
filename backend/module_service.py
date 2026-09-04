import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import packs


class ModuleService:
    """Read the module manifest (core + boosters) and resolve workflow/module ownership."""

    def __init__(self, config_dir: Optional[Path] = None):
        self.config_dir = config_dir or Path(__file__).resolve().parent.parent / "config"
        self.manifest_file = self.config_dir / "modules.json"
        self.profiles_file = self.config_dir / "install_profiles.json"
        self.workflow_file = self.config_dir / "workflow_api.json"
        self.nodes_file = self.config_dir / "nodes.json"
        self.settings_file = self.config_dir / "runtime_settings.json"

    def pack_roots(self) -> List[Path]:
        """The pack folders this install is pointed at, or none."""
        try:
            with self.settings_file.open("r", encoding="utf-8-sig") as f:
                return packs.pack_roots(json.load(f))
        except (OSError, ValueError):
            return []

    def load_manifest(self) -> Dict[str, Any]:
        if not self.manifest_file.exists():
            return {"version": 0, "modules": []}
        with self.manifest_file.open("r", encoding="utf-8-sig") as f:
            data = json.load(f)
        data.setdefault("modules", [])
        return data

    def load_profiles(self) -> Dict[str, Any]:
        if not self.profiles_file.exists():
            return {"version": 0, "profiles": {}}
        with self.profiles_file.open("r", encoding="utf-8-sig") as f:
            data = json.load(f)
        data.setdefault("profiles", {})
        return data

    def load_workflow_mapping(self) -> Dict[str, Any]:
        """The app's mapping, then any a pack adds.

        Pack entries are merged here rather than only in workflow_service,
        which is where they used to stop. The two loaders then disagreed:
        /api/workflow/list found a pack workflow through workflow_service and
        reported it, while workflow_index() looked it up here, did not find it,
        and answered "unowned" - so the page listed the workflow and refused to
        run it. One question, one answer.
        """
        mapping: Dict[str, Any] = {}
        if self.workflow_file.exists():
            with self.workflow_file.open("r", encoding="utf-8-sig") as f:
                mapping = json.load(f)
        for key, spec in packs.mapping(self.pack_roots()).items():
            mapping.setdefault(key, spec)
        return mapping

    def load_node_configs(self) -> Dict[str, Dict[str, Any]]:
        if not self.nodes_file.exists():
            return {}
        with self.nodes_file.open("r", encoding="utf-8-sig") as f:
            nodes = json.load(f)
        return {
            str(node.get("name")): node
            for node in nodes
            if isinstance(node, dict) and node.get("name")
        }

    def enabled_module_ids(self) -> Set[str]:
        # list_modules, not load_manifest: a pack module is installed too, and
        # this set is what the UI checks before it will open a page.
        return {
            str(module.get("id"))
            for module in self.list_modules(enabled_only=False, include_validation=False)
            if module.get("enabled", True) and module.get("id")
        }

    def list_modules(self, enabled_only: bool = False, include_validation: bool = True) -> List[Dict[str, Any]]:
        """Every module this install has: the manifest, then the packs.

        Merged here and not in load_manifest(), which apply_profile() writes
        back to config/modules.json - a pack module reaching that file would
        put a folder somebody else does not have into the shipped manifest.
        Reading sees packs; writing sees only what the app ships.
        """
        manifest = self.load_manifest()
        modules = [
            dict(module)
            for module in manifest.get("modules", [])
            if isinstance(module, dict) and (not enabled_only or module.get("enabled", True))
        ]
        known = {str(m.get("id")) for m in modules}
        for extra in packs.modules(self.pack_roots()):
            if str(extra.get("id")) in known:
                continue
            if enabled_only and not extra.get("enabled", True):
                continue
            modules.append(dict(extra))
        if not include_validation:
            return modules

        workflows = self.load_workflow_mapping()
        nodes = self.load_node_configs()
        for module in modules:
            module["validation"] = self.validate_module(module, workflows, nodes)
        return modules

    def get_module(self, module_id: str, include_validation: bool = True) -> Optional[Dict[str, Any]]:
        for module in self.list_modules(enabled_only=False, include_validation=include_validation):
            if module.get("id") == module_id:
                return module
        return None

    def workflow_index(self) -> Dict[str, Dict[str, Any]]:
        """workflow id -> the module that owns it.

        The link runs through `workflow_api.json` rather than `modules.json`,
        because the two files hold different things: a module lists the graph
        *files* it ships (which `require_nodes.py` walks to derive its node
        packs), while a workflow id only exists in the mapping. The mapping
        states the owner outright, and falls back to matching the filename
        against the module's own list when an entry predates that field.
        """
        modules = self.list_modules(enabled_only=False, include_validation=False)
        by_id = {str(m.get("id")): m for m in modules}

        index: Dict[str, Dict[str, Any]] = {}
        for workflow_id, spec in self.load_workflow_mapping().items():
            if workflow_id.startswith("_") or not isinstance(spec, dict):
                continue  # `_note` and friends are documentation
            owner = by_id.get(str(spec.get("module") or ""))
            if owner is None:
                filename = str(spec.get("filename") or "").replace("\\", "/")
                owner = next(
                    (m for m in modules
                     if filename and filename in [
                         str(w).replace("\\", "/") for w in (m.get("workflows") or [])]),
                    None,
                )
            if owner is not None:
                index[str(workflow_id)] = owner
        return index

    def module_for_workflow(self, workflow_id: str) -> Optional[Dict[str, Any]]:
        return self.workflow_index().get(workflow_id)

    def is_workflow_available(self, workflow_id: str) -> Dict[str, Any]:
        module = self.module_for_workflow(workflow_id)
        if not module:
            return {
                "available": False,
                "reason": "unowned",
                "detail": f"No module owns workflow '{workflow_id}'",
                "module_id": None,
            }
        if not module.get("enabled", True):
            return {
                "available": False,
                "reason": "module_disabled",
                "detail": f"Module '{module.get('id')}' is not installed or enabled",
                "module_id": module.get("id"),
                "module_label": module.get("label"),
                "module_pack": module.get("pack"),
            }
        validation = module.get("validation") or self.validate_module(module)
        if not validation.get("ok", True):
            return {
                "available": False,
                "reason": "module_invalid",
                "detail": "Module manifest is incomplete for this workflow",
                "module_id": module.get("id"),
                "module_label": module.get("label"),
                "validation": validation,
            }
        return {
            "available": True,
            "reason": "ok",
            "module_id": module.get("id"),
            "module_label": module.get("label"),
            "module_pack": module.get("pack"),
        }

    def annotate_workflow(self, workflow_id: str, workflow_info: Dict[str, Any]) -> Dict[str, Any]:
        module = self.module_for_workflow(workflow_id)
        availability = self.is_workflow_available(workflow_id)
        annotated = dict(workflow_info)
        annotated["id"] = workflow_id
        if module:
            annotated["module_id"] = module.get("id")
            annotated["module_label"] = module.get("label")
            annotated["module_pack"] = module.get("pack")
            annotated["module_area"] = module.get("area")
            annotated["module_enabled"] = bool(module.get("enabled", True))
        else:
            annotated["module_id"] = None
            annotated["module_label"] = None
            annotated["module_pack"] = None
            annotated["module_area"] = None
            annotated["module_enabled"] = False
        annotated["module_available"] = availability.get("available", False)
        annotated["module_availability_reason"] = availability.get("reason")
        return annotated

    def validate_module(
        self,
        module: Dict[str, Any],
        workflows: Optional[Dict[str, Any]] = None,
        nodes: Optional[Dict[str, Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        workflow_map = workflows if workflows is not None else self.load_workflow_mapping()
        node_map = nodes if nodes is not None else self.load_node_configs()
        # `workflows` holds graph files. A module is valid when each one exists
        # on disk - not when it happens to be named in the mapping, which is a
        # separate question about whether the UI can drive it.
        # A pack's graphs sit in its own folder, so both places are searched.
        # Without this every pack module was invalid on a technicality - its
        # files were all present, just not where the app keeps its own - and
        # the page refused to open with "Module manifest is incomplete".
        graphs_dirs = [self.config_dir.parent / "backend" / "workflows"]
        graphs_dirs.extend(packs.workflow_dirs(self.pack_roots()))
        missing_workflows = [
            str(entry)
            for entry in module.get("workflows", []) or []
            if not any((d / str(entry)).exists() for d in graphs_dirs)
        ]
        # A string names a pack pinned in config/nodes.json and has to be found
        # there. A full entry carries its own url and pin - it is the
        # declaration, so there is nothing to look up. Same rule sync_nodes.ps1
        # applies when it decides what it can install.
        missing_node_configs = [
            node_name
            for node_name in module.get("custom_nodes", []) or []
            if isinstance(node_name, str) and node_name not in node_map
        ]
        return {
            "ok": not missing_workflows and not missing_node_configs,
            "missing_workflows": missing_workflows,
            "missing_node_configs": missing_node_configs,
        }

    def get_install_state(self) -> Dict[str, Any]:
        manifest = self.load_manifest()
        profiles = self.load_profiles()
        modules = self.list_modules(enabled_only=False, include_validation=True)
        enabled = [m for m in modules if m.get("enabled", True)]
        disabled = [m for m in modules if not m.get("enabled", True)]
        return {
            "version": manifest.get("version", 0),
            "active_profile": manifest.get("active_profile"),
            "policy": manifest.get("policy", {}),
            "profiles": profiles.get("profiles", {}),
            "default_profile": profiles.get("default_profile"),
            "enabled_module_ids": sorted(self.enabled_module_ids()),
            "enabled_count": len(enabled),
            "disabled_count": len(disabled),
            "modules": modules,
        }

    def apply_profile(self, profile_id: str, persist: bool = True) -> Dict[str, Any]:
        profiles = self.load_profiles().get("profiles", {})
        profile = profiles.get(profile_id)
        if not profile:
            raise ValueError(f"Unknown install profile '{profile_id}'")

        enabled_ids = {str(module_id) for module_id in profile.get("enabled_modules", []) or []}
        manifest = self.load_manifest()
        updated_modules: List[Dict[str, Any]] = []
        for module in manifest.get("modules", []):
            if not isinstance(module, dict):
                continue
            next_module = dict(module)
            next_module["enabled"] = str(next_module.get("id")) in enabled_ids
            updated_modules.append(next_module)

        manifest["modules"] = updated_modules
        manifest["active_profile"] = profile_id
        if persist:
            with self.manifest_file.open("w", encoding="utf-8") as f:
                json.dump(manifest, f, indent=2)
                f.write("\n")

        return {
            "profile_id": profile_id,
            "label": profile.get("label"),
            "enabled_module_ids": sorted(enabled_ids),
            "enabled_count": len(enabled_ids),
        }


module_service = ModuleService()