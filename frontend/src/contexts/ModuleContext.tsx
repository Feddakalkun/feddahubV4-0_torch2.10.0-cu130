import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { FEDDA_MODULES, type FeddaModule } from '../modules/registry';
import {
  buildEnabledSourceIds,
  getAvailableModules,
  getDefaultTab,
  getPageMeta,
  getValidTabs,
  type BackendModule,
} from '../modules/moduleSelectors';

type ModuleInstallState = {
  version: number;
  active_profile?: string;
  policy?: Record<string, unknown>;
  enabled_module_ids?: string[];
};

type ModuleContextValue = {
  loading: boolean;
  error: string | null;
  backendModules: BackendModule[];
  enabledSourceIds: Set<string>;
  availableModules: FeddaModule[];
  validTabs: Set<string>;
  pageMeta: Record<string, { label: string; Icon: FeddaModule['Icon'] }>;
  defaultTab: string;
  installState: ModuleInstallState | null;
  refreshModules: () => Promise<void>;
  isTabAvailable: (tab: string) => boolean;
};

const ModuleContext = createContext<ModuleContextValue | null>(null);

async function fetchInstallState(): Promise<{
  modules: BackendModule[];
  installState: ModuleInstallState;
}> {
  const response = await fetch('/api/modules/install-state');
  const data = await response.json();
  if (!data?.success) {
    throw new Error(data?.error || 'Failed to load module install state');
  }
  return {
    modules: Array.isArray(data.modules) ? data.modules : [],
    installState: {
      version: data.version ?? 0,
      active_profile: data.active_profile,
      policy: data.policy,
      enabled_module_ids: data.enabled_module_ids,
    },
  };
}

export function ModuleProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backendModules, setBackendModules] = useState<BackendModule[]>([]);
  const [installState, setInstallState] = useState<ModuleInstallState | null>(null);

  const refreshModules = async () => {
    try {
      const next = await fetchInstallState();
      setBackendModules(next.modules);
      setInstallState(next.installState);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load modules');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshModules();
  }, []);

  const enabledSourceIds = useMemo(() => buildEnabledSourceIds(backendModules), [backendModules]);
  const availableModules = useMemo(
    () => getAvailableModules(FEDDA_MODULES, enabledSourceIds),
    [enabledSourceIds],
  );
  const validTabs = useMemo(() => getValidTabs(availableModules), [availableModules]);
  const pageMeta = useMemo(() => getPageMeta(availableModules), [availableModules]);
  const defaultTab = useMemo(() => getDefaultTab(availableModules, 'image'), [availableModules]);

  const value = useMemo<ModuleContextValue>(
    () => ({
      loading,
      error,
      backendModules,
      enabledSourceIds,
      availableModules,
      validTabs,
      pageMeta,
      defaultTab,
      installState,
      refreshModules,
      isTabAvailable: (tab: string) => validTabs.has(tab),
    }),
    [
      loading,
      error,
      backendModules,
      enabledSourceIds,
      availableModules,
      validTabs,
      pageMeta,
      defaultTab,
      installState,
    ],
  );

  return <ModuleContext.Provider value={value}>{children}</ModuleContext.Provider>;
}

export function useModules() {
  const context = useContext(ModuleContext);
  if (!context) {
    throw new Error('useModules must be used within ModuleProvider');
  }
  return context;
}