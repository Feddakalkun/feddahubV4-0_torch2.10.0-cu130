import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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
  /**
   * Three hooks for the one workflow a list of fields cannot describe.
   *
   * MiniMax Director is a storyboard: shots you drag, references you drop.
   * v3 answered that with a second page of eleven hundred lines carrying its
   * own submit, its own model banner and its own output pane, and the two
   * pages drifted. These let the storyboard sit above the generated controls
   * and own the inputs it drives, while everything else - the schema, the
   * missing-model banner, generate, cancel, outputs - stays here.
   */
  extraTop?: ReactNode;
  /** Below the generated controls, above Generate. v3 called this one
   *  extraSections and used it for a collapsible advanced panel. */
  extraBottom?: ReactNode;
  /** Merged over the field values at submit. Wins on a clash. */
  /** Given the current field values, so a page can react to what is set. */
  extraParams?: (values: Record<string, FieldValue>) => Record<string, unknown>;
  /** Field keys the custom UI drives, so they are not drawn twice. */
  hideKeys?: string[];
}

/**
 * A seed box opens on -1, meaning "pick one for me".
 *
 * The graph's own seed is whatever number the author's last render happened
 * to use, so every user started from the same one and two Generates without
 * touching anything returned the same picture. Filling a random number in
 * instead fixed that but hid it: a number in the box looks chosen, and
 * nothing says it will be different next time. -1 says so.
 *
 * /api/generate swaps it for a real value before submitting - ComfyUI
 * declares a seed as min 0 and would refuse the sentinel.
 */
const SEED_RANDOM = -1;

/**
 * What a workflow opens on.
 *
 * The example wins over the graph's own value. A converted graph carries
 * whatever its author last typed - on Z-Image txt2img that is "Breathtaking
 * Award-winningreliastic woman on a horse", typos and all - and that is the
 * first thing anyone reads. The example is written for the model in front of
 * them, so it is the better default and it teaches the right shape of prompt
 * by being there.
 */
const seedValues = (
  fields: WorkflowField[],
  example: Record<string, FieldValue> = {},
): Record<string, FieldValue> => {
  const out: Record<string, FieldValue> = {};
  for (const field of fields) {
    if (field.control === 'lora') continue;
    if (field.role === 'seed') { out[field.key] = SEED_RANDOM; continue; }
    out[field.key] = (example[field.key]
      ?? field.default
      ?? (field.control === 'number' ? 0 : '')) as FieldValue;
  }
  return out;
};

export const WorkflowPage = ({
  workflowId, extraTop, extraBottom, extraParams, hideKeys,
}: WorkflowPageProps) => {
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
        setValues(seedValues(data.fields, data.example ?? {}));
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
    // isGenerating no longer blocks: a second press queues behind the first,
    // which is what ComfyUI does with it anyway.
    if (!schema) return;
    const queueing = isGenerating || state === 'executing';
    setIsGenerating(true);
    if (!queueing) setImages([]);
    try {
      const params: Record<string, unknown> = { ...values, ...(extraParams?.(values) ?? {}) };
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

  // How many jobs are behind this one, asked of ComfyUI rather than counted
  // here - other pages and the ComfyUI tab queue into the same line.
  const [pending, setPending] = useState(0);
  useEffect(() => {
    // `busy` is computed further down, at render; the same condition, here.
    if (!(isGenerating || state === 'executing')) { setPending(0); return undefined; }
    let alive = true;
    const tick = async () => {
      try {
        const d = await (await fetch(`${BACKEND_API.BASE_URL}/api/queue`)).json();
        if (alive) setPending(Number(d?.pending ?? 0));
      } catch { /* the count simply stops updating */ }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [state, isGenerating]);

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
  const hidden = new Set(hideKeys ?? []);
  const shown = schema.fields.filter((f) => !hidden.has(f.key));
  const prose = shown.filter((f) => f.control === 'text' && f.multiline);
  const compact = shown.filter(
    (f) => f.control !== 'lora' && !(f.control === 'text' && f.multiline),
  );
  const loraField = schema.fields.find((f) => f.control === 'lora');

  const busy = isGenerating || state === 'executing';

  // A required field left empty used to be submitted as an empty string.
  // ComfyUI then tried to open its own input folder as a file and failed
  // several nodes in, with a permission error naming a directory - a
  // message that says nothing about the picture nobody chose.
  const missing = shown.filter(
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
        {extraTop}

        {/* Quality in one click. The values behind each of these are ordinary
            fields and stay visible below, so a preset is a starting point that
            can be argued with rather than a mode that hides things. */}
        {(schema.presets?.length ?? 0) > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/30">
              Quality
            </span>
            {schema.presets!.map((preset) => {
              const active = Object.entries(preset.values)
                .every(([k, v]) => values[k] === v);
              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setValues((current) => ({ ...current, ...preset.values }))}
                  disabled={busy}
                  title={preset.note || ''}
                  className={`rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition disabled:opacity-40 ${
                    active
                      ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
                      : 'border-white/10 text-white/60 hover:border-white/25 hover:text-white'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        )}

        {prose.map((field) => (
          <FieldControl
            key={field.key}
            field={field}
            value={values[field.key] ?? ''}
            onChange={(next) => setValue(field.key, next)}
            disabled={busy}
          />
        ))}

        <div className="workflow-control-grid">
          {compact.map((field) => (
            <div
              key={field.key}
              // A seed and a file picker need the room; everything else reads
              // fine in one cell. A slot menu is the exception - fifteen
              // chips and a strength each, which inside one 212px cell is a
              // column of single words.
              className={field.control === 'slots' ? 'is-full'
                : field.role === 'seed' || field.control === 'file'
                  || field.control === 'audio' ? 'is-wide' : undefined}
            >
              <FieldControl
                field={field}
                value={values[field.key] ?? null}
                onChange={(next) => setValue(field.key, next)}
                disabled={busy}
              />
            </div>
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

        {extraBottom}

        {/* Both, while something is running. Queueing another is the normal
            way to work - change one line, send it, keep going - and hiding
            Generate for the duration was the only thing preventing it. */}
        <div className={busy ? 'flex items-center gap-2' : undefined}>
          <button
            type="button"
            className="workflow-cockpit-generate flex-1"
            onClick={submit}
            disabled={missing.length > 0}
            title={missing.length
              ? `Still needed: ${missing.map((f) => f.label).join(', ')}`
              : busy ? 'Send another with the settings as they are now' : undefined}
          >
            <Sparkles className="h-4 w-4" />
            {missing.length
              ? `Add ${missing.map((f) => f.label).join(', ')}`
              : busy
                ? (pending > 0 ? `Queue another · ${pending} waiting` : 'Queue another')
                : 'Generate'}
          </button>
          {busy && (
            <button type="button" className="workflow-cancel-btn" onClick={cancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
    </WorkflowShell>
  );
};
