import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Home, Package, Sparkles } from 'lucide-react';
import { CardGrid, type CardItem } from './components/layout/CardGrid';
import { HFTokenReminder } from './components/ui/HFTokenReminder';
import { TopSystemStrip } from './components/ui/TopSystemStrip';
import { GlobalOutputStrip } from './components/layout/GlobalOutputStrip';
import { ToastProvider } from './components/ui/Toast';
import { ComfyExecutionProvider } from './contexts/ComfyExecutionContext';
import { ModuleProvider, useModules } from './contexts/ModuleContext';
import { ModelDownloadProvider } from './contexts/ModelDownloadContext';
import { GalleryPage } from './pages/GalleryPage';
import { ModuleUnavailablePage } from './pages/ModuleUnavailablePage';
import { WorkflowPage } from './pages/WorkflowPage';
import { MiniMaxDirectorPage } from './pages/MiniMaxDirectorPage';
import {
  ACTIVE_TAB_STORAGE_KEY,
  APP_VERSION_LABEL,
  FEDDA_AREAS,
  FEDDA_FAMILIES,
  FEDDA_MODEL_GROUPS,
  FEDDA_MODULES,
  type ModuleArea,
} from './modules/registry';
import { findModuleForTab, getExtraFamilies } from './modules/moduleSelectors';

/*
 * Home -> area -> family -> workflow.
 *
 * Four levels, one card component, and the routing below is the whole of it.
 * v3 reached this differently: twenty-two imported pages, a bespoke landing
 * page, a second bespoke component for the level under it, and a studio page
 * per model. That structure is one of the reasons v4 started over.
 *
 * A level here is a filter over a list. Adding "Audio Workflows" is a row in
 * FEDDA_AREAS; adding SDXL under Image is a row in FEDDA_FAMILIES. Neither
 * needs a component, and neither can drift from the others' look, because
 * there is only one card.
 */

type ViewMode = 'home' | 'area' | 'family' | 'model' | 'workspace';

type AppLocation = {
  view: ViewMode;
  area?: ModuleArea;
  family?: string;
  model?: string;
  activeTab: string;
};

function FeddaApp() {
  const { loading, availableModules, packAreas, validTabs, pageMeta, defaultTab, isTabAvailable } =
    useModules();

  const resolveTab = (tab: string | null | undefined): string =>
    (tab && validTabs.has(tab) ? tab : defaultTab);

  const readActiveTab = (): string => {
    try {
      return resolveTab(localStorage.getItem(ACTIVE_TAB_STORAGE_KEY));
    } catch {
      return defaultTab;
    }
  };

  const readLocationFromHash = (): AppLocation => {
    const fallback = readActiveTab();
    if (typeof window === 'undefined') return { view: 'home', activeTab: fallback };

    const hash = window.location.hash.replace(/^#\/?/, '').trim();
    if (!hash || hash === 'home') return { view: 'home', activeTab: fallback };

    const [head, rest] = [hash.split('/')[0], hash.split('/').slice(1).join('/')];
    if (head === 'area' && rest) {
      return { view: 'area', area: rest as ModuleArea, activeTab: fallback };
    }
    if (head === 'family' && rest) {
      const family = FEDDA_FAMILIES.find((f) => f.id === decodeURIComponent(rest));
      return { view: 'family', family: family?.id, area: family?.area, activeTab: fallback };
    }
    if (head === 'model' && rest) {
      const group = FEDDA_MODEL_GROUPS.find((g) => g.id === decodeURIComponent(rest));
      const owner = FEDDA_FAMILIES.find((f) => f.id === group?.family);
      return { view: 'model', model: group?.id, family: owner?.id,
               area: owner?.area, activeTab: fallback };
    }
    if (head === 'tab' && rest) {
      return { view: 'workspace', activeTab: decodeURIComponent(rest) };
    }
    return { view: 'workspace', activeTab: hash };
  };

  const initial = readLocationFromHash();
  const [location, setLocation] = useState<AppLocation>(initial);
  const { view, area, family, model, activeTab } = location;

  useEffect(() => {
    if (loading) return;
    setLocation((cur) => ({ ...cur, activeTab: resolveTab(cur.activeTab) }));
  }, [loading, defaultTab, validTabs]);

  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, resolveTab(activeTab));
    } catch {
      /* a browser with storage off still navigates fine */
    }
  }, [activeTab, defaultTab, validTabs]);

  const encode = (loc: AppLocation): string => {
    if (loc.view === 'home') return '#/home';
    if (loc.view === 'area') return `#/area/${loc.area}`;
    if (loc.view === 'family') return `#/family/${encodeURIComponent(loc.family ?? '')}`;
    if (loc.view === 'model') return `#/model/${encodeURIComponent(loc.model ?? '')}`;
    return `#/tab/${encodeURIComponent(resolveTab(loc.activeTab))}`;
  };

  useEffect(() => {
    const sync = () => setLocation(readLocationFromHash());
    if (typeof window !== 'undefined' && !window.location.hash) {
      window.history.replaceState({ fedda: true }, '', encode(location));
    }
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, [location, defaultTab, validTabs]);

  const navigate = (next: AppLocation) => {
    setLocation(next);
    if (typeof window === 'undefined') return;
    const hash = encode(next);
    if (window.location.hash !== hash) {
      window.history.pushState({ fedda: true }, '', hash);
    }
  };

  // --- what each level shows -------------------------------------------------

  // A family is offered only where something under it is installed, so a
  // core-only machine sees Z-Image with two workflows rather than six, and an
  // area with nothing installed does not pretend otherwise.
  // The compiled families, plus one for every module that claims a family
  // nothing declares - which is how a pack installed from a folder gets a card
  // to sit under instead of being counted in an area and shown on no page.
  const allFamilies = useMemo(
    () => [...FEDDA_FAMILIES, ...getExtraFamilies(FEDDA_FAMILIES, availableModules, Package, FEDDA_MODULES)],
    [availableModules],
  );

  const familiesIn = (id: ModuleArea) =>
    allFamilies.filter(
      (f) => f.area === id
        && availableModules.some((m) => m.family === f.id && !m.hidden),
    );

  // The app's own top-level cards, then any a pack declares. A pack that puts
  // its modules under image or video declares none and appears inside those;
  // one that wants a card of its own on the front page says so and gets it.
  const allAreas = useMemo(() => {
    const known = new Set(FEDDA_AREAS.map((a) => a.id));
    const extra = packAreas
      .filter((a) => typeof a.id === 'string' && !known.has(a.id as string))
      .map((a) => ({
        id: a.id as ModuleArea,
        label: typeof a.label === 'string' ? a.label : (a.id as string),
        description: typeof a.description === 'string' ? a.description : '',
        Icon: Package,
      }));
    return [...FEDDA_AREAS, ...extra];
  }, [packAreas]);

  const areaCards: CardItem[] = useMemo(
    () => allAreas.map((a) => {
      const families = familiesIn(a.id);
      const count = availableModules.filter((m) => m.area === a.id && !m.hidden).length;
      return {
        id: a.id,
        label: a.label,
        description: a.description,
        Icon: a.Icon,
        count,
        wip: families.length === 0,
      };
    }),
    [availableModules, allAreas],
  );

  const familyCards: CardItem[] = useMemo(() => {
    if (!area) return [];
    return familiesIn(area).map((f) => ({
      id: f.id,
      label: f.label,
      description: f.description,
      Icon: f.Icon,
      count: availableModules.filter((m) => m.family === f.id && !m.hidden).length,
    }));
  }, [area, availableModules]);

  // Models under this family that have something installed. Empty for a
  // family with one model, which is what keeps Z-Image a single click away.
  const modelsIn = (familyId: string) =>
    FEDDA_MODEL_GROUPS.filter(
      (g) => g.family === familyId
        && availableModules.some((m) => m.group === g.id && !m.hidden),
    );

  const modelCards: CardItem[] = useMemo(() => {
    if (!family) return [];
    return modelsIn(family).map((g) => ({
      id: g.id,
      label: g.label,
      description: g.description,
      Icon: g.Icon,
      count: availableModules.filter((m) => m.group === g.id && !m.hidden).length,
    }));
  }, [family, availableModules]);

  const modelWorkflowCards: CardItem[] = useMemo(() => {
    if (!model) return [];
    return availableModules
      .filter((m) => m.group === model && !m.hidden)
      .map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        Icon: m.Icon,
        countLabel: m.pack === 'booster' ? 'booster' : 'core',
        count: undefined,
      }));
  }, [model, availableModules]);

  const workflowCards: CardItem[] = useMemo(() => {
    if (!family) return [];
    return availableModules
      .filter((m) => m.family === family && !m.group && !m.hidden)
      .map((m) => ({
        id: m.id,
        label: m.label,
        description: m.description,
        Icon: m.Icon,
        countLabel: m.pack === 'booster' ? 'booster' : 'core',
        count: undefined,
      }));
  }, [family, availableModules]);

  // --- chrome ----------------------------------------------------------------

  const areaDef = FEDDA_AREAS.find((a) => a.id === area);
  const familyDef = FEDDA_FAMILIES.find((f) => f.id === family);
  const modelDef = FEDDA_MODEL_GROUPS.find((g) => g.id === model);
  const meta = pageMeta[resolveTab(activeTab)] ?? { label: APP_VERSION_LABEL, Icon: Sparkles };

  const title = view === 'home' ? APP_VERSION_LABEL
    : view === 'area' ? (areaDef?.label ?? 'Workflows')
      : view === 'family' ? (familyDef?.label ?? 'Workflows')
        : view === 'model' ? (modelDef?.label ?? 'Workflows')
          : meta.label;
  const Icon = view === 'home' ? Sparkles
    : view === 'area' ? (areaDef?.Icon ?? Sparkles)
      : view === 'family' ? (familyDef?.Icon ?? Sparkles)
        : view === 'model' ? (modelDef?.Icon ?? Sparkles)
          : meta.Icon;

  const goHome = () => navigate({ view: 'home', activeTab });
  const goBack = () => {
    if (view === 'workspace') {
      const owner = FEDDA_MODULES.find((m) => m.id === activeTab);
      // Back goes to whichever level actually opened this, so a workflow
      // under a model returns to its model rather than skipping past it.
      if (owner?.group) {
        return navigate({ view: 'model', model: owner.group, family: owner.family,
                          area: owner.area, activeTab });
      }
      return owner?.family
        ? navigate({ view: 'family', family: owner.family, area: owner.area, activeTab })
        : goHome();
    }
    if (view === 'model') {
      return navigate({ view: 'family', family: modelDef?.family, area, activeTab });
    }
    if (view === 'family') {
      return navigate({ view: 'area', area: familyDef?.area ?? 'image', activeTab });
    }
    return goHome();
  };

  const renderWorkspace = () => {
    if (!isTabAvailable(activeTab)) {
      const requested = findModuleForTab(activeTab, FEDDA_MODULES);
      return (
        <ModuleUnavailablePage
          tab={activeTab}
          moduleLabel={requested?.label}
          pack={requested?.pack}
        />
      );
    }
    if (activeTab === 'gallery') return <GalleryPage />;
    // Director is a storyboard, and a storyboard is not a list of fields.
    // It still renders through WorkflowPage - this only supplies the editor
    // that sits above the generated controls. Both the full-weight and the
    // GGUF twin take it; they differ in one loader node, not in what the
    // page is.
    if (activeTab.startsWith('minimax-h3-director')) {
      return <MiniMaxDirectorPage workflowId={activeTab} />;
    }
    return <WorkflowPage workflowId={activeTab} />;
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#050506] text-sm text-slate-400">
        Loading modules...
      </div>
    );
  }

  return (
    <div className="flex h-screen theme-bg-app text-white overflow-hidden font-sans selection:bg-white/20">
      <main className="flex-1 flex flex-col overflow-hidden theme-bg-main">
        <header className="h-14 border-b border-white/5 flex items-center px-6 shrink-0 z-10 justify-between backdrop-blur-sm bg-black/20">
          <div className="flex items-center gap-3">
            {view !== 'home' && (
              <>
                <button onClick={goBack} className="v15-home-btn inline-flex items-center gap-2" title="Back">
                  <ArrowLeft className="h-3.5 w-3.5" /> Back
                </button>
                <button onClick={goHome} className="v15-home-btn inline-flex items-center gap-2" title="Home">
                  <Home className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            <Icon className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-semibold text-white tracking-tight">{title}</h2>
          </div>
          <TopSystemStrip />
        </header>

        {view === 'workspace' && <GlobalOutputStrip />}

        <div className="flex-1 min-h-0 overflow-hidden">
          {view === 'home' && (
            <CardGrid
              items={areaCards}
              banner={<HFTokenReminder />}
              kicker="FEDDA Hub"
              title="What are you making?"
              onSelect={(id) => navigate({ view: 'area', area: id as ModuleArea, activeTab })}
            />
          )}

          {view === 'area' && (
            <CardGrid
              items={familyCards}
              kicker={areaDef?.label}
              title="Choose a model"
              empty={`No ${areaDef?.label.toLowerCase() ?? 'workflows'} are installed on this machine yet.`}
              onSelect={(id) => {
                const f = FEDDA_FAMILIES.find((x) => x.id === id);
                navigate({ view: 'family', family: id, area: f?.area ?? area, activeTab });
              }}
            />
          )}

          {view === 'family' && (
            // A family with models shows those; one without opens straight
            // onto its workflows, which is why Z-Image needed no change.
            modelCards.length > 0 ? (
              <CardGrid
                items={modelCards}
                kicker={familyDef?.label}
                title="Choose a model"
                onSelect={(id) => navigate({ view: 'model', model: id, family, area, activeTab })}
              />
            ) : (
              <CardGrid
                items={workflowCards}
                kicker={familyDef?.label}
                title="Choose a workflow"
                onSelect={(id) => navigate({ view: 'workspace', activeTab: id })}
              />
            )
          )}

          {view === 'model' && (
            <CardGrid
              items={modelWorkflowCards}
              kicker={`${familyDef?.label ?? ''} ${modelDef?.label ?? ''}`.trim()}
              title="Choose a workflow"
              onSelect={(id) => navigate({ view: 'workspace', activeTab: id })}
            />
          )}

          {view === 'workspace' && renderWorkspace()}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ComfyExecutionProvider>
      <ToastProvider>
        <ModuleProvider>
          {/* Outside the page tree so a download outlives navigating away. */}
          <ModelDownloadProvider>
            <FeddaApp />
          </ModelDownloadProvider>
        </ModuleProvider>
      </ToastProvider>
    </ComfyExecutionProvider>
  );
}
