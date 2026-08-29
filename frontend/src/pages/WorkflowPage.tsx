import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, Sparkles } from 'lucide-react';
import { WorkflowShell } from '../components/layout/WorkflowShell';
import { FieldControl } from '../components/controls/FieldControl';
import { LoraPanel, type LoraEntry } from '../components/workflows/LoraPanel';
import { useToast } from '../components/ui/Toast';
import { useComfyExecution } from '../contexts/ComfyExecutionContext';
import { BACKEND_API } from '../config/api';
import { comfyService } from '../services/comfyService';
import { cancelGeneration } from '../utils/cancelGeneration';
import type { FieldValue, WorkflowField, WorkflowSchema } from '../types/workflow';

/**
 * The page every workflow uses.
 *
 * There is no second one, and that is the point. v3 reached 61 files under
 * `pages/` because each new workflow arrived as a component written for it:
 * `ZImageTxt2Img.tsx` alone is 1021 lines wrapping an 837-line cockpit, all of
 * it for a single graph. Every one of them was reasonable on the day it was
 * written and the total was not.
 *
 * Here the controls come from `GET /api/workflow/schema/{id}`, which the
 * backend builds from three sources - the mapping says which node, the graph
 * says what value it holds, `object_info` says what kind of control it is. So
 * `style` arrives as a 26-item picker and `denoise` as a slider bounded 0 to 1
 * because the *node* says so, not because anyone typed it here.
 *
 * Adding a workflow is an entry in `config/workflow_api.json` and a row in
 * `modules/registry.ts`. No component.
 */

interface WorkflowPageProps {
  workflowId: string;
}

const seedValues = (fields: WorkflowField[]): Record<string, FieldValue> => {
  const out: Record<string, FieldValue> = {};
  for (const field of fields) {
    if (field.control === 'lora') continue;
    out[field.key] = (field.default ?? (field.control === 'number' ? 0 : '')) as FieldValue;
  }
  return out;
};

export const WorkflowPage = ({ workflowId }: WorkflowPageProps) => {
  const { toast } = useToast();
  const { state } = useComfyExecution();

  const [schema, setSchema] = useState<WorkflowSchema | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [loras, setLoras] = useState<LoraEntry[]>([]);
  const [installedLoras, setInstalledLoras] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [promptId, setPromptId] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>([]);

  // --- the schema is the page ------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setSchema(null);
    setLoadError(null);
    (async () => {
      try {
        const response = await fetch(
          `${BACKEND_API.BASE_URL}/api/workflow/schema/${encodeURIComponent(workflowId)}`,
        );
        if (!response.ok) throw new Error(`Backend answered ${response.status}`);
        const data: WorkflowSchema = await response.json();
        if (cancelled) return;
        setSchema(data);
        setValues(seedValues(data.fields));
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Could not read this workflow');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [workflowId]);

  // --- the LoRA list, only when the workflow has a slot for one --------------
  const hasLoraField = useMemo(
    () => Boolean(schema?.fields.some((f) => f.control === 'lora')),
    [schema],
  );

  useEffect(() => {
    if (!hasLoraField) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${BACKEND_API.BASE_URL}/api/lora/list`);
        const data = await response.json();
        const names: string[] = Array.isArray(data) ? data : (data.loras ?? []);
        if (!cancelled) setInstalledLoras(names);
      } catch {
        // An empty list is a correct answer here: the panel says so itself
        // rather than the page failing to render over a missing sidecar.
        if (!cancelled) setInstalledLoras([]);
      }
    })();
    return () => { cancelled = true; };
  }, [hasLoraField]);

  const setValue = useCallback((key: string, next: FieldValue) => {
    setValues((current) => ({ ...current, [key]: next }));
  }, []);

  // --- running it ------------------------------------------------------------
  const submit = async () => {
    if (!schema || isGenerating) return;
    setIsGenerating(true);
    setImages([]);
    try {
      const params: Record<string, unknown> = { ...values };
      if (hasLoraField) {
        // The graph's Power Lora Loader is a placeholder the backend deletes
        // and rebuilds as _lora_0, _lora_1, ... so the count is ours to choose.
        params.loras = loras.filter((entry) => entry.name);
      }

      // Our own socket's name goes with the request. ComfyUI addresses
      // progress, previews and the finished filenames to whoever submitted the
      // prompt, and the submitting party is the backend - so without this it
      // sends them to a client_id nothing is listening on, and the page has no
      // idea anything is happening until the status poll finds the file.
      const response = await fetch(`${BACKEND_API.BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflow_id: workflowId,
          params,
          client_id: comfyService.clientId,
        }),
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.detail || 'The backend refused the graph');
      setPromptId(data.prompt_id);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Generate failed', 'error');
      setIsGenerating(false);
    }
  };

  const cancel = async () => {
    const ok = await cancelGeneration(promptId);
    toast(ok ? 'Cancelled' : 'Could not cancel - is ComfyUI running?', ok ? 'info' : 'error');
    setIsGenerating(false);
    setPromptId(null);
  };

  // Poll for the finished picture. The websocket in ComfyExecutionContext
  // reports progress; this asks the backend where the file landed.
  useEffect(() => {
    if (!promptId) return;
    let stop = false;
    const tick = async () => {
      try {
        const response = await fetch(
          `${BACKEND_API.BASE_URL}/api/generate/status/${promptId}`
          + `?workflow_id=${encodeURIComponent(workflowId)}`,
        );
        const data = await response.json();
        if (stop) return;
        if (data.status === 'completed') {
          setImages(data.images ?? []);
          setIsGenerating(false);
          setPromptId(null);
          return;
        }
        if (data.status === 'failed') {
          toast(data.detail || 'The run failed', 'error');
          setIsGenerating(false);
          setPromptId(null);
          return;
        }
      } catch {
        /* keep polling; a dropped request is not a failed run */
      }
      if (!stop) window.setTimeout(tick, 1200);
    };
    const handle = window.setTimeout(tick, 800);
    return () => { stop = true; window.clearTimeout(handle); };
  }, [promptId, workflowId, toast]);

  // --- rendering -------------------------------------------------------------
  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="cockpit-panel max-w-md text-center">
          <AlertCircle className="mx-auto mb-3 h-5 w-5 text-amber-400" />
          <p className="text-sm text-white/80">Could not load “{workflowId}”.</p>
          <p className="mt-2 text-xs text-white/45">{loadError}</p>
          <p className="mt-3 text-xs text-white/35">
            The backend serves this from <code>config/workflow_api.json</code>. If it is
            running, check the workflow has an entry there.
          </p>
        </div>
      </div>
    );
  }

  if (!schema) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Reading the workflow...
      </div>
    );
  }

  // Long text gets its own row; everything else shares the control grid. This
  // is layout by control type rather than by field name, so a workflow nobody
  // has written yet still lands somewhere sensible.
  const prose = schema.fields.filter((f) => f.control === 'text' && f.multiline);
  const compact = schema.fields.filter(
    (f) => f.control !== 'lora' && !(f.control === 'text' && f.multiline),
  );
  const loraField = schema.fields.find((f) => f.control === 'lora');

  const busy = isGenerating || state === 'executing';

  // A required field left empty used to be submitted as an empty string.
  // ComfyUI then tried to open its own input folder as a file and failed
  // several nodes in, with a permission error naming a directory - a
  // message that says nothing about the picture nobody chose.
  const missing = schema.fields.filter(
    (f) => f.required && !String(values[f.key] ?? '').trim(),
  );

  return (
    <WorkflowShell
      title={schema.name}
      eyebrow={schema.makes === 'video' ? 'Video' : 'Image'}
      description={schema.description}
      icon={Sparkles}
      workflowId={workflowId}
      isGenerating={busy}
      canGenerate={!busy}
      output={
        images.length ? (
          <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2">
            {images.map((src) => (
              <img
                key={src}
                src={src.startsWith('http') ? src : `${BACKEND_API.BASE_URL}${src}`}
                alt=""
                className="w-full rounded-lg border border-white/10"
              />
            ))}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-white/35">
            Nothing generated yet
          </div>
        )
      }
    >
      <div className="workflow-cockpit workflow-cockpit-stack">
        {prose.map((field) => (
          <FieldControl
            key={field.key}
            field={field}
            value={values[field.key] ?? ''}
            onChange={(next) => setValue(field.key, next)}
            disabled={busy}
          />
        ))}

        <div className="cockpit-control-grid">
          {compact.map((field) => (
            <FieldControl
              key={field.key}
              field={field}
              value={values[field.key] ?? null}
              onChange={(next) => setValue(field.key, next)}
              disabled={busy}
            />
          ))}
        </div>

        {loraField && (
          <LoraPanel
            title={loraField.label}
            // The schema says which model this is. Hardcoding Z-Image told
            // someone on a MiniMax page that no Z-Image LoRAs were installed,
            // which is true and beside the point.
            familyLabel={schema.name}
            stack={{
              entries: loras,
              onChange: setLoras,
              options: installedLoras,
            }}
          />
        )}

        {busy ? (
          <button type="button" className="workflow-cancel-btn" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="workflow-cockpit-generate"
            onClick={submit}
            disabled={missing.length > 0}
            title={missing.length ? `Still needed: ${missing.map((f) => f.label).join(', ')}` : undefined}
          >
            <Sparkles className="h-4 w-4" />
            {missing.length
              ? `Add ${missing.map((f) => f.label).join(', ')}`
              : 'Generate'}
          </button>
        )}
      </div>
    </WorkflowShell>
  );
};
