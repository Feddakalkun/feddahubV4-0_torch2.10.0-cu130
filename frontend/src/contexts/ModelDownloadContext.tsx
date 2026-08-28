import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BACKEND_API } from '../config/api';

/**
 * Tracks a model download so the progress survives leaving the page.
 *
 * The per-workflow hook polls from inside the modal, so closing it or clicking
 * anywhere else threw the progress away - the bytes kept arriving but nothing
 * showed them, and a 28 GB checkpoint is exactly when someone wants to browse.
 *
 * The workflow id is kept in localStorage rather than state alone: a download
 * outlives a page reload too, and picking the poll back up afterwards is worth
 * one string.
 */

const ACTIVE_KEY = 'fedda.download.active';

type Progress = {
  workflowId: string;
  /** 0-1 across every file the workflow needs. */
  fraction: number;
  currentBytes: number;
  totalBytes: number;
  /** The file currently moving, for the label. */
  filename: string;
  remaining: number;
};

type Value = {
  progress: Progress | null;
  /** Called when a download is kicked off, from wherever. */
  track: (workflowId: string) => void;
};

const ModelDownloadContext = createContext<Value | null>(null);

export function ModelDownloadProvider({ children }: { children: ReactNode }) {
  const [workflowId, setWorkflowId] = useState<string | null>(() => {
    try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
  });
  const [progress, setProgress] = useState<Progress | null>(null);

  const track = (id: string) => {
    try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* private mode */ }
    setWorkflowId(id);
  };

  useEffect(() => {
    if (!workflowId) { setProgress(null); return undefined; }
    let mounted = true;

    const stop = () => {
      try { localStorage.removeItem(ACTIVE_KEY); } catch { /* private mode */ }
      if (mounted) { setWorkflowId(null); setProgress(null); }
    };

    const poll = async () => {
      try {
        const res = await fetch(
          `${BACKEND_API.BASE_URL}/api/workflow/download-live-progress/${encodeURIComponent(workflowId)}`);
        if (!res.ok || !mounted) return;
        const data: { files?: Array<Record<string, unknown>> } = await res.json();
        const files = (data.files ?? []).map((f) => ({
          filename: String(f.filename ?? ''),
          exists: Boolean(f.exists),
          currentBytes: Number(f.currentBytes ?? 0),
          totalBytes: Number(f.totalBytes ?? 0),
        }));
        if (!files.length) { stop(); return; }

        const remaining = files.filter((f) => !f.exists).length;
        if (remaining === 0) { stop(); return; }

        const currentBytes = files.reduce((n, f) => n + (f.exists ? f.totalBytes : f.currentBytes), 0);
        const totalBytes = files.reduce((n, f) => n + f.totalBytes, 0);
        // The file with bytes on disk but not finished is the one moving.
        const active = files.find((f) => !f.exists && f.currentBytes > 0) ?? files.find((f) => !f.exists);
        if (mounted) {
          setProgress({
            workflowId,
            fraction: totalBytes > 0 ? currentBytes / totalBytes : 0,
            currentBytes, totalBytes,
            filename: active?.filename ?? '',
            remaining,
          });
        }
      } catch { /* a dropped poll is not worth clearing the bar over */ }
    };

    void poll();
    const id = setInterval(poll, 2000);
    return () => { mounted = false; clearInterval(id); };
  }, [workflowId]);

  const value = useMemo<Value>(() => ({ progress, track }), [progress]);
  return <ModelDownloadContext.Provider value={value}>{children}</ModelDownloadContext.Provider>;
}

export function useModelDownload() {
  const ctx = useContext(ModelDownloadContext);
  if (!ctx) throw new Error('useModelDownload must be used inside ModelDownloadProvider');
  return ctx;
}
