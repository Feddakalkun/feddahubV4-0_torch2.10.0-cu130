import { useState } from 'react';
import { AlertTriangle, CheckCircle2, DownloadCloud } from 'lucide-react';
import { ModelStatusModal } from './ModelStatusModal';
import { useComfyExecution } from '../../contexts/ComfyExecutionContext';
import { useWorkflowDownloadStatus } from '../../hooks/useWorkflowDownloadStatus';

function fmtBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${(bytes / 1_000).toFixed(0)} KB`;
}

/** Shared affordance so all three banner states open the same inventory. */
const DetailsLink = ({ onOpen }: { onOpen: () => void }) => (
  <button
    type="button"
    onClick={onOpen}
    className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/25 underline-offset-2 transition hover:text-white/60 hover:underline"
  >
    View models
  </button>
);

export const WorkflowDownloadBanner = ({ workflowId }: { workflowId: string }) => {
  // The banner answers "can I run this"; the modal answers everything else.
  const [detailOpen, setDetailOpen] = useState(false);
  const { isDownloaderNode } = useComfyExecution();
  const { preflight, liveFiles, missingCount, allReady, checked, manualDownloading, startDownload } =
    useWorkflowDownloadStatus(workflowId);

  // Active download (workflow run or manual pre-download) — live progress panel
  if ((isDownloaderNode || manualDownloading) && liveFiles.length > 0) {
    const completed = liveFiles.filter((f) => f.exists).length;
    return (
      <div className="border-b border-amber-500/20 bg-amber-500/[0.06] px-5 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DownloadCloud className="h-3.5 w-3.5 text-amber-400 animate-pulse flex-shrink-0" />
            <span className="text-[11px] font-bold uppercase tracking-widest text-amber-300">
              Downloading Models
            </span>
          </div>
          <span className="text-[10px] font-mono text-amber-400/60">
            {completed} / {liveFiles.length} ready
          </span>
        </div>

        <div className="space-y-1.5">
          {liveFiles.map((f) => {
            const pct = f.exists ? 100 : f.totalBytes > 0 ? Math.min(99, Math.floor((f.currentBytes / f.totalBytes) * 100)) : 0;
            const hasTotal = f.totalBytes > 0;
            return (
              <div key={`${f.folder}/${f.filename}`} className="space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[10px] text-zinc-300 truncate min-w-0 font-mono">{f.filename}</span>
                  <span className={`text-[10px] font-mono flex-shrink-0 ${f.error ? 'text-amber-400' : 'text-zinc-500'}`}>
                    {f.exists
                      ? '✓ Done'
                      : f.error
                        ? 'Blocked'
                        : f.currentBytes > 0
                          ? hasTotal
                            ? `${pct}% · ${fmtBytes(f.currentBytes)} / ${fmtBytes(f.totalBytes)}`
                            : fmtBytes(f.currentBytes)
                          : 'Waiting…'}
                  </span>
                </div>

                {/* The reason, in full. A gated model waits forever and the
                    backend has known why the whole time; "Waiting..." was the
                    app keeping it to itself. */}
                {f.error && !f.exists && (
                  <p className="text-[10px] leading-snug text-amber-300/80">{f.error}</p>
                )}
                <div className="h-[3px] w-full bg-white/5 rounded-full overflow-hidden">
                  {f.exists ? (
                    <div className="h-full bg-emerald-500" style={{ width: '100%' }} />
                  ) : hasTotal && f.currentBytes > 0 ? (
                    <div className="h-full bg-amber-400 transition-all duration-500" style={{ width: `${pct}%` }} />
                  ) : f.currentBytes > 0 ? (
                    <div className="h-full bg-amber-400/60 animate-pulse w-2/3" />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-[10px] text-zinc-600">
          {isDownloaderNode
            ? 'Runs automatically when downloads complete.'
            : 'Pre-downloading — you can keep working, generation is ready when this finishes.'}
        </p>
        <DetailsLink onOpen={() => setDetailOpen(true)} />
        {detailOpen && <ModelStatusModal workflowId={workflowId} onClose={() => setDetailOpen(false)} />}
      </div>
    );
  }

  // Pre-flight — missing models warning bar
  if (checked && missingCount > 0 && !isDownloaderNode && !manualDownloading) {
    const missing = preflight.filter((f) => !f.exists);
    return (
      <div className="border-b border-amber-500/15 bg-amber-500/[0.04] px-5 py-2.5 space-y-1.5">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500/80 flex-shrink-0" />
          <span className="text-[11px] font-semibold text-amber-400/90">
            {missingCount} model{missingCount !== 1 ? 's' : ''} missing for this workflow
          </span>
          <button
            type="button"
            onClick={() => { void startDownload(); }}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-300 transition hover:bg-amber-500/20"
          >
            <DownloadCloud className="h-3 w-3" />
            Download models
          </button>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-0.5 pl-5">
          {missing.map((f) => (
            <span key={`${f.folder}/${f.filename}`} className="text-[10px] font-mono text-zinc-600 truncate">
              {f.filename}
            </span>
          ))}
        </div>

        <p className="text-[10px] text-zinc-600 pl-5">
          Download now, or just click Generate — the app downloads and runs automatically.
        </p>
        <div className="pl-5"><DetailsLink onOpen={() => setDetailOpen(true)} /></div>
        {detailOpen && <ModelStatusModal workflowId={workflowId} onClose={() => setDetailOpen(false)} />}
      </div>
    );
  }

  // All models present — a subtle, always-visible confirmation so the models
  // status is discoverable on every page. The "Download models" bar above takes
  // over the moment anything is missing or a download starts.
  if (checked && allReady && !isDownloaderNode && !manualDownloading) {
    return (
      <div className="border-b border-white/5 bg-emerald-500/[0.03] px-5 py-1.5">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-3 w-3 text-emerald-500/60 flex-shrink-0" />
          <span className="text-[10px] font-medium tracking-wide text-zinc-500">
            Models ready for this workflow
          </span>
          <DetailsLink onOpen={() => setDetailOpen(true)} />
        </div>
        {detailOpen && <ModelStatusModal workflowId={workflowId} onClose={() => setDetailOpen(false)} />}
      </div>
    );
  }

  return null;
};
