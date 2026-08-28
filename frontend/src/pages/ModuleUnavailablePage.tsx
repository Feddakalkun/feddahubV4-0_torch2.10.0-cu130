import { PackageOpen } from 'lucide-react';

interface ModuleUnavailablePageProps {
  tab: string;
  moduleLabel?: string;
  pack?: string;
}

export const ModuleUnavailablePage = ({ tab, moduleLabel, pack }: ModuleUnavailablePageProps) => {
  const packLabel = pack === 'booster' ? 'booster pack' : 'module';

  return (
    <div className="flex h-full items-center justify-center bg-[#050506] px-8">
      <div className="max-w-xl rounded-2xl border border-white/10 bg-[#0b0d12] p-8 text-center shadow-2xl">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-amber-400/20 bg-amber-400/10">
          <PackageOpen className="h-7 w-7 text-amber-300" />
        </div>
        <h2 className="text-xl font-semibold text-white">Module Not Installed</h2>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          <span className="text-slate-200">{moduleLabel || tab}</span> is part of a {packLabel} that is not enabled
          in this install. The core app stays available; install or enable the pack to unlock this workflow.
        </p>
        <p className="mt-4 text-xs uppercase tracking-[0.2em] text-slate-500">Tab: {tab}</p>
      </div>
    </div>
  );
};