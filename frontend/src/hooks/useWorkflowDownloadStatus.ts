import { useCallback, useEffect, useRef, useState } from 'react';
import { useComfyExecution } from '../contexts/ComfyExecutionContext';
import { useModelDownload } from '../contexts/ModelDownloadContext';
import { BACKEND_API } from '../config/api';

export interface DownloadFileStatus {
  filename: string;
  /** Why this one is not moving. Absent while it is simply not started. */
  error?: string;
  folder: string;
  exists: boolean;
  currentBytes: number;
  totalBytes: number;
}

export interface PreflightFileStatus {
  filename: string;
  folder: string;
  exists: boolean;
  size_bytes: number;
  /** Set when pressing Download will not fetch this one, and why. */
  note?: string;
}

export interface WorkflowDownloadState {
  preflight: PreflightFileStatus[];
  liveFiles: DownloadFileStatus[];
  missingCount: number;
  /** Missing files this app can actually fetch. What the button acts on. */
  fetchableCount: number;
  allReady: boolean;
  checked: boolean;
  manualDownloading: boolean;
  startDownload: () => Promise<void>;
}

export function useWorkflowDownloadStatus(workflowId: string): WorkflowDownloadState {
  const { isDownloaderNode } = useComfyExecution();
  const { track } = useModelDownload();
  const [preflight, setPreflight] = useState<PreflightFileStatus[]>([]);
  const [liveFiles, setLiveFiles] = useState<DownloadFileStatus[]>([]);
  const [checked, setChecked] = useState(false);
  const [manualDownloading, setManualDownloading] = useState(false);
  const wasDownloadingRef = useRef(false);

  const fetchPreflight = useCallback(async () => {
    try {
      const resp = await fetch(
        `${BACKEND_API.BASE_URL}/api/workflow/model-status/${encodeURIComponent(workflowId)}`
      );
      if (!resp.ok) return;
      const data: { files?: Array<{ filename?: unknown; folder?: unknown; exists?: unknown; size_bytes?: unknown; note?: unknown }> } = await resp.json();
      const files: PreflightFileStatus[] = (data.files ?? []).map((f) => ({
        filename: String(f.filename ?? ''),
        folder: String(f.folder ?? ''),
        exists: Boolean(f.exists),
        size_bytes: Number(f.size_bytes ?? 0),
        note: f.note ? String(f.note) : undefined,
      }));
      setPreflight(files);
      setChecked(true);
    } catch {
      // Network unavailable — silent, no crash
    }
  }, [workflowId]);

  // Initial preflight on mount
  useEffect(() => {
    fetchPreflight();
  }, [fetchPreflight]);

  // Refresh preflight when a download run completes
  useEffect(() => {
    const wasDownloading = wasDownloadingRef.current;
    wasDownloadingRef.current = isDownloaderNode;
    if (wasDownloading && !isDownloaderNode) {
      fetchPreflight();
    }
  }, [isDownloaderNode, fetchPreflight]);

  // Start a manual pre-download (no generation) of all missing models
  const startDownload = useCallback(async () => {
    try {
      const resp = await fetch(
        `${BACKEND_API.BASE_URL}/api/workflow/download-models/${encodeURIComponent(workflowId)}`,
        { method: 'POST' }
      );
      if (!resp.ok) return;
      // A 200 means the request was understood, not that anything is now
      // downloading: the endpoint skips every file it has no URL for. Going
      // by the response alone left the button spinning "Downloading" over a
      // wire with nothing on it, which is how a missing table entry reached
      // the user as an app that had simply stopped working.
      const data: { started?: unknown } = await resp.json().catch(() => ({}));
      const started = Array.isArray(data.started) ? data.started.length : 0;
      if (started === 0) return;
      setManualDownloading(true);
      // Hand the workflow to the global tracker: this modal unmounts the
      // moment the user clicks away, and the download does not.
      track(workflowId);
    } catch {
      // Network unavailable — leave state unchanged
    }
  }, [workflowId, track]);

  // Poll live file sizes while a download could be running. The third condition
  // matters: /api/generate now starts missing-model downloads itself through the
  // backend's fast downloader, and that path sets neither isDownloaderNode (that
  // is the ComfyUI node executing) nor manualDownloading (that is the button).
  // Without it the bytes climb on disk while the banner shows nothing, and the
  // 409 telling the user to "watch the progress bar" points at a bar that never
  // appears. Anything still missing is reason enough to watch.
  // A file that cannot progress must not keep the poll alive. A gated model
  // never arrives, so "something is still missing" stayed true forever and the
  // backend took a request every two seconds for the rest of the session.
  // Anything blocked is subtracted; if that leaves nothing, there is nothing to
  // watch and the reason is already on screen.
  const blocked = liveFiles.filter((f) => f.error).map((f) => f.filename);
  const canStillArrive = preflight.some(
    (f) => !f.exists && !f.note && !blocked.includes(f.filename),
  );
  const pollingActive = isDownloaderNode || manualDownloading || canStillArrive;
  useEffect(() => {
    if (!pollingActive) {
      setLiveFiles([]);
      return;
    }
    let mounted = true;
    const poll = async () => {
      try {
        const resp = await fetch(
          `${BACKEND_API.BASE_URL}/api/workflow/download-live-progress/${encodeURIComponent(workflowId)}`
        );
        if (!resp.ok || !mounted) return;
        const data: { files?: Array<{ filename?: unknown; folder?: unknown; exists?: unknown; currentBytes?: unknown; totalBytes?: unknown }> } = await resp.json();
        if (!mounted) return;
        const files = (data.files ?? []).map((f) => ({
          filename: String(f.filename ?? ''),
          folder: String(f.folder ?? ''),
          exists: Boolean(f.exists),
          currentBytes: Number(f.currentBytes ?? 0),
          totalBytes: Number(f.totalBytes ?? 0),
        }));
        setLiveFiles(files);
        // Adopt a download nobody told us about: /api/generate starts these
        // itself, and one already running when the page loads has no click to
        // report. Bytes moving on an unfinished file is the only signal there
        // is, and without it the top bar stays empty while the disk fills.
        if (files.some((f) => !f.exists && f.currentBytes > 0)) track(workflowId);
        // Every file on disk means the download is done, whoever started it.
        // Re-running preflight clears hasMissingFiles, which stops this poll —
        // otherwise a Generate-triggered download would leave it running forever
        // since nothing else resets that flag.
        if (files.length > 0 && files.every((f) => f.exists)) {
          if (manualDownloading) setManualDownloading(false);
          fetchPreflight();
        }
      } catch {
        // Silent — polling failures don't matter
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [pollingActive, manualDownloading, workflowId, fetchPreflight, track]);

  const missingCount = preflight.filter((f) => !f.exists).length;
  // A file a node pack brings, or one with no source at all, is missing but
  // not fetchable. Offering Download for those is offering a button that
  // cannot do anything.
  const fetchableCount = preflight.filter((f) => !f.exists && !f.note).length;

  return {
    preflight,
    liveFiles,
    missingCount,
    fetchableCount,
    allReady: checked && missingCount === 0,
    checked,
    manualDownloading,
    startDownload,
  };
}
