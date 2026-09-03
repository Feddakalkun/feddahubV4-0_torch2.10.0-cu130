import { useEffect, useMemo } from 'react';
import { AlertTriangle, CheckCircle2, DownloadCloud, Loader2, X } from 'lucide-react';
import { useWorkflowDownloadStatus } from '../../hooks/useWorkflowDownloadStatus';
import { useComfyExecution } from '../../contexts/ComfyExecutionContext';
import { BACKEND_API } from '../../config/api';

/**
 * Full model inventory for one workflow.
 *
 * The banner answers "can I run this yet"; this answers everything else - what
 * each file is, where it lands, how big it is, and how far along it is. Both
 * read the same preflight + live-progress data, so they can never disagree.
 */

const fmtBytes = (bytes: number): string => {
  if (!bytes) return '—';
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${(bytes / 1_000).toFixed(0)} KB`;
};

interface ModelStatusModalProps {
  workflowId: string;
  workflowLabel?: string;
  onClose: () => void;
}

export const ModelStatusModal = ({ workflowId, workflowLabel, onClose }: ModelStatusModalProps) => {
  const fetchOne = async (filename: string) => {
    try {
      await fetch(
        `${BACKEND_API.BASE_URL}/api/models/fetch/${encodeURIComponent(filename)}`,
        { method: 'POST' },
      );
    } catch { /* the row keeps saying Get; nothing else changes */ }
  };
  const { isDownloaderNode } = useComfyExecution();
  const { preflight, liveFiles, missingCount, fetchableCount, allReady, checked,
    manualDownloading, startDownload } = useWorkflowDownloadStatus(workflowId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const downloading = isDownloaderNode || manualDownloading;

  // Live bytes are keyed by folder+filename; fold them onto the preflight list so
  // one row per file shows both what it is and how far along it is.
  const rows = useMemo(() => {
    const live = new Map(liveFiles.map((f) => [`${f.folder}/${f.filename}`, f]));
    return preflight.map((f) => {
      const l = live.get(`${f.folder}/${f.filename}`);
      const total = l?.totalBytes || f.size_bytes || 0;
      const current = f.exists ? total : (l?.currentBytes ?? 0);
      return {
        ...f,
        note: f.note || l?.error || '',
        exists: f.exists || Boolean(l?.exists),
        current,
        total,
        pct: f.exists || l?.exists ? 100 : total > 0 ? Math.min(99, Math.floor((current / total) * 100)) : 0,
      };
    });
  }, [preflight, liveFiles]);

  const totalBytes = rows.reduce((sum, r) => sum + r.total, 0);
  const missingBytes = rows
    .filter((r) => !r.exists && !r.note)
    .reduce((sum, r) => sum + Math.max(0, r.total - r.current), 0);
  const readyCount = rows.filter((r) => r.exists).length;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-[820px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0b0c11] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-4 border-b border-white/8 px-5 py-3.5">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-white">Models</div>
            <div className="truncate text-[11px] text-white/35">{workflowLabel || workflowId}</div>
          </div>
          <div className="flex items-center gap-3">
            {/* A workflow with no declared files is not "all present" - it just
                never told us anything, so claiming readiness would be a lie. */}
            {checked && rows.length > 0 && (
              <span
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold ${
                  allReady
                    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
                    : 'border-amber-500/25 bg-amber-500/10 text-amber-300'
                }`}
              >
                {allReady ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                {allReady ? 'All present' : `${missingCount} missing`}
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/10 p-1.5 text-white/40 transition hover:text-white/80"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
          {!checked ? (
            <div className="flex items-center justify-center gap-2 py-14 text-[12px] text-white/35">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking models…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-14 text-center text-[12px] text-white/35">
              This workflow declares no downloadable models.
            </div>
          ) : (
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 bg-[#0b0c11]">
                <tr className="text-[9px] font-black uppercase tracking-[0.16em] text-white/25">
                  <th className="px-5 py-2 font-black">File</th>
                  <th className="px-3 py-2 font-black">Folder</th>
                  <th className="px-3 py-2 text-right font-black">Size</th>
                  <th className="px-5 py-2 text-right font-black">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.filter((r) => !r.optional).map((r) => (
                  <tr key={`${r.folder}/${r.filename}`} className="border-t border-white/5">
                    <td className="max-w-[320px] px-5 py-2.5">
                      <div className="truncate font-mono text-[11px] text-zinc-300" title={r.filename}>
                        {r.filename}
                      </div>
                      {/* Why this one is not moving. Without it a file the
                          app will not fetch draws the same as one it simply
                          has not started - and the difference is the whole
                          answer to "why is nothing happening". */}
                      {!r.exists && r.note && (
                        <div className="mt-1 text-[10px] leading-snug text-white/35">
                          {r.note}
                          {/* A licence has to be accepted by the person, not by
                              the app - that is what a licence is. So the most
                              this can do is put the page one click away instead
                              of printing a URL to be selected and copied. */}
                          {(r as any).licence_url ? (
                            <>
                              {' '}
                              <a
                                href={(r as any).licence_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-emerald-300 underline underline-offset-2 hover:text-emerald-200"
                              >
                                Open the licence page
                              </a>
                            </>
                          ) : null}
                        </div>
                      )}
                      {!r.exists && r.current > 0 && (
                        <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-white/5">
                          <div
                            className="h-full bg-amber-400 transition-all duration-500"
                            style={{ width: `${r.pct}%` }}
                          />
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="rounded border border-white/8 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-white/35">
                        {r.folder || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[10px] text-white/40">
                      {fmtBytes(r.total)}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      {r.exists ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-400/80">
                          <CheckCircle2 className="h-3 w-3" /> Ready
                        </span>
                      ) : r.current > 0 ? (
                        <span className="font-mono text-[10px] text-amber-300">{r.pct}%</span>
                      ) : r.note ? (
                        <span className="text-[10px] font-semibold text-white/30">Not fetched here</span>
                      ) : (
                        <span className="text-[10px] font-semibold text-white/25">Missing</span>
                      )}
                    </td>
                  </tr>
                ))}
                {/* Alternatives to something above, not gaps. A smaller build
                    of a model you already have is a choice, so it gets its own
                    heading and its own button rather than joining the count of
                    what is missing. */}
                {rows.some((r) => r.optional) && (
                  <>
                    <tr>
                      <td colSpan={4} className="px-5 pb-1 pt-4">
                        <div className="text-[9px] font-black uppercase tracking-[0.16em] text-white/25">
                          Smaller builds — optional
                        </div>
                        <div className="mt-0.5 text-[10px] text-white/30">
                          The same model, quantised further. Download one and it appears in
                          this workflow's model picker.
                        </div>
                      </td>
                    </tr>
                    {rows.filter((r) => r.optional).map((r) => (
                      <tr key={`${r.folder}/${r.filename}`} className="border-t border-white/5">
                        <td className="max-w-[320px] px-5 py-2.5">
                          <div className="truncate font-mono text-[11px] text-zinc-400" title={r.filename}>
                            {r.filename}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="rounded border border-white/8 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-white/35">
                            {r.folder || '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-[10px] text-white/40">
                          {fmtBytes(r.total)}
                        </td>
                        <td className="px-5 py-2.5 text-right">
                          {r.exists ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-400/80">
                              <CheckCircle2 className="h-3 w-3" /> Ready
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => { void fetchOne(r.filename); }}
                              className="rounded border border-white/10 px-2 py-1 text-[10px] font-semibold
                                         text-white/45 transition hover:border-violet-400/40 hover:text-white/85"
                            >
                              Get
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </>
                )}
              </tbody>
            </table>
          )}
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-white/8 px-5 py-3">
          <div className="text-[10px] text-white/30">
            {checked && rows.length > 0 && (
              <>
                {readyCount} of {rows.length} on disk · {fmtBytes(totalBytes)} total
                {fetchableCount > 0 && <> · {fmtBytes(missingBytes)} to fetch</>}
              </>
            )}
          </div>
          {fetchableCount > 0 && (
            <button
              type="button"
              disabled={downloading}
              onClick={() => { void startDownload(); }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-300 transition hover:bg-amber-500/20 disabled:opacity-40"
            >
              {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadCloud className="h-3.5 w-3.5" />}
              {downloading ? 'Downloading' : 'Download missing'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
};
