import type { FeddaFamily, FeddaModule } from './registry';

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

/**
 * Cards for modules the compiled registry has never heard of.
 *
 * FEDDA_MODULES is TypeScript, so the backend could only ever switch a card on
 * or off - it could not add one. That made a module installed from a folder
 * invisible no matter what the backend reported, because the card it needed
 * did not exist to be enabled.
 *
 * A module the backend lists and the registry does not is turned into a card
 * from its own fields. Only the icon has to be invented; everything else the
 * declaration already says.
 */
export function getExtraModules(
  known: FeddaModule[],
  backendModules: Array<Record<string, unknown>>,
  fallbackIcon: FeddaModule['Icon'],
): FeddaModule[] {
  // Two id spaces, and comparing across them was the whole fault. A backend
  // module is named in config/modules.json - "z-image-core", "flux-krea" - and
  // a UI module is named for its tab: "z-image-txt2img". They are joined by
  // sourceModuleId, not by id. Matching row.id against m.id therefore never
  // matched anything the app ships, so every backend module became a card and
  // "Choose a model" grew Core Shell, Z-Image Core, FLUX Krea and the rest.
  const seen = new Set(known.map((m) => m.sourceModuleId as string));
  const out: FeddaModule[] = [];
  for (const row of backendModules) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (!id || seen.has(id) || row.enabled === false) continue;
    seen.add(id);
    const tabs = Array.isArray(row.tabs) ? row.tabs.filter((x): x is string => typeof x === 'string') : [];
    // A module with no tabs has no page to open, so a card for it would be a
    // dead end. Nothing is drawn rather than something that goes nowhere.
    if (tabs.length === 0) continue;
    out.push({
      id,
      sourceModuleId: id as FeddaModule['sourceModuleId'],
      family: typeof row.family === 'string' ? row.family : id,
      area: (row.area === 'video' ? 'video' : 'image') as FeddaModule['area'],
      label: typeof row.label === 'string' ? row.label : id,
      description: typeof row.notes === 'string' ? row.notes : '',
      pack: (row.pack === 'core' ? 'core' : 'booster') as FeddaModule['pack'],
      tabs,
      defaultTab: tabs.find((x) => x !== 'video' && x !== 'image') ?? tabs[0],
      Icon: fallbackIcon,
    });
  }
  return out;
}

/**
 * Families for modules the compiled registry has no family for.
 *
 * Navigation is home -> area -> family -> workflow, and a family card only
 * appears when FEDDA_FAMILIES declares one. A pack module therefore reached
 * availableModules, was counted in its area, and then had nothing to sit
 * under - present in every list and visible on no page.
 *
 * One family per unclaimed module, taking its label and description from the
 * module itself. A pack that wants several workflows under one card sets the
 * same `family` on each; nothing else has to be declared.
 */
export function getExtraFamilies(
  known: FeddaFamily[],
  modules: FeddaModule[],
  fallbackIcon: FeddaFamily['Icon'],
  shipped: FeddaModule[] = [],
): FeddaFamily[] {
  const claimed = new Set(known.map((f) => f.id));
  // Only modules that did not come with the app. Several of its own sit under
  // a family whose id is not their own - Core Shell, Z-Image Core, FLUX Krea -
  // and synthesising one for each put four cards on "Choose a model" that
  // belong nowhere. The app's navigation is not this function's to change.
  const own = new Set(shipped.map((m) => m.id));
  const out: FeddaFamily[] = [];
  for (const module of modules) {
    if (own.has(module.id)) continue;
    const family = module.family;
    if (!family || claimed.has(family)) continue;
    claimed.add(family);
    out.push({
      id: family,
      area: module.area,
      label: module.label,
      description: module.description,
      Icon: module.Icon ?? fallbackIcon,
      // The family is offered when its own module is installed, which for a
      // pack is the pack itself - nothing else gates it.
      requiresAnyOf: [module.sourceModuleId],
    });
  }
  return out;
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