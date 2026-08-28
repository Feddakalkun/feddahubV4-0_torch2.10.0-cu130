import type { FeddaModule } from './registry';

export type BackendModule = {
  id: string;
  enabled?: boolean;
  pack?: string;
  area?: string;
  tabs?: string[];
  workflows?: string[];
  validation?: {
    ok?: boolean;
  };
};

export function buildEnabledSourceIds(backendModules: BackendModule[]): Set<string> {
  return new Set(
    backendModules
      .filter((module) => module.enabled !== false)
      .map((module) => module.id),
  );
}

export function isUiModuleAvailable(module: FeddaModule, enabledSourceIds: Set<string>): boolean {
  if (module.requiresAnyOf?.length) {
    return module.requiresAnyOf.some((moduleId) => enabledSourceIds.has(moduleId));
  }
  return enabledSourceIds.has(module.sourceModuleId);
}

export function getAvailableModules(
  allModules: FeddaModule[],
  enabledSourceIds: Set<string>,
): FeddaModule[] {
  return allModules.filter((module) => isUiModuleAvailable(module, enabledSourceIds));
}

export function getValidTabs(modules: FeddaModule[]): Set<string> {
  return new Set(modules.flatMap((module) => module.tabs));
}

export function getPageMeta(modules: FeddaModule[]): Record<string, { label: string; Icon: FeddaModule['Icon'] }> {
  return Object.fromEntries(
    modules.flatMap((module) =>
      module.tabs.map((tab) => [tab, { label: module.label, Icon: module.Icon }]),
    ),
  );
}

export function getDefaultTab(modules: FeddaModule[], area: 'image' | 'video' | 'home' = 'image'): string {
  if (area === 'image') {
    return modules.find((module) => module.area === 'image')?.defaultTab || 'z-image-txt2img';
  }
  if (area === 'video') {
    return modules.find((module) => module.area === 'video')?.defaultTab || 'wan22-img2vid';
  }
  // Any module will do; having art was never what made one openable.
  return modules[0]?.defaultTab || 'home';
}

export function isTabAvailable(tab: string, modules: FeddaModule[]): boolean {
  return modules.some((module) => module.tabs.includes(tab));
}

export function findModuleForTab(tab: string, modules: FeddaModule[]): FeddaModule | undefined {
  return modules.find((module) => module.tabs.includes(tab));
}