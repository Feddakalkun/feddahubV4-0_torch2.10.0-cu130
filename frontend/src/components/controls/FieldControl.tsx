import { useRef, useState } from 'react';
import { AlertCircle, Brush, Dice5, Loader2, Upload } from 'lucide-react';
import type { FieldValue, WorkflowField } from '../../types/workflow';
import { BACKEND_API } from '../../config/api';
import { MaskBrush } from '../workflows/MaskBrush';
import { cn } from '../../lib/styles';

/**
 * One control per `control` value the descriptor emits. That is the whole
 * presentation layer.
 *
 * v3 hand-placed these: `SimpleImageCockpit` is 837 lines of controls wired to
 * one workflow, and a second workflow meant a second cockpit. The look here is
 * deliberately the same - same `cockpit-*` classes out of `index.css` - but
 * which controls appear, in what order, with what bounds and what options, is
 * read off the workflow rather than typed out.
 *
 * A control added here becomes available to every workflow at once, which is
 * the trade the whole design turns on.
 */

interface Props {
  field: WorkflowField;
  value: FieldValue;
  onChange: (next: FieldValue) => void;
  disabled?: boolean;
}

const SEED_MAX = 2 ** 53 - 1;

/** Options arrive either bare or already labelled; render them the same way. */
type Choice = { value: string | number; label: string };
const choices = (options: WorkflowField['options']): Choice[] =>
  (options ?? []).map((o) =>
    (typeof o === 'object' && o !== null
      ? { value: o.value, label: String(o.label) }
      : { value: o, label: String(o) }));

/** A panel head that also reports the live value, as the cockpit's sliders do. */
const Head = ({ label, hint }: { label: string; hint?: string }) => (
  <div className="cockpit-panel-head">
    <span>{label}</span>
    {hint !== undefined && <span>{hint}</span>}
  </div>
);

export const FieldControl = ({ field, value, onChange, disabled }: Props) => {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [maskOpen, setMaskOpen] = useState(false);
  const [masked, setMasked] = useState(false);
  /**
   * The file as the browser has it, kept only so the mask editor can draw on a
   * blob URL. It cannot use the uploaded copy: that is served from ComfyUI on
   * another origin, which taints the canvas and makes the export throw.
   */
  const [localUrl, setLocalUrl] = useState<string | null>(null);

  /**
   * The file goes to ComfyUI's input folder and the app keeps only the name it
   * comes back with. ComfyUI renames on collision - image.png becomes
   * image (2).png - so sending the name we chose would reference a different
   * picture than the one just uploaded.
   */
  const upload = async (file: File, isMask = false) => {
    setUploading(true);
    setUploadError(null);
    if (!isMask) {
      // A fresh source image drops any mask painted on the previous one.
      setLocalUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(file); });
      setMasked(false);
    }
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch(`${BACKEND_API.BASE_URL}/api/upload`, {
        method: 'POST',
        body,
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.detail || `Upload failed (${response.status})`);
      }
      onChange(data.filename);
      setPreview(data.url ?? null);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  switch (field.control) {
    // ----------------------------------------------------------------- text
    case 'text': {
      const text = typeof value === 'string' ? value : '';
      return (
        <div className="cockpit-panel">
          <Head label={field.label} hint={field.required ? 'required' : undefined} />
          {field.multiline ? (
            <textarea
              className="fedda-input w-full rounded-lg px-3 py-2 text-sm text-white/90 resize-y"
              rows={field.key === 'prompt' ? 5 : 2}
              value={text}
              disabled={disabled}
              placeholder={field.key === 'negative'
                ? 'What to keep out of the picture'
                : 'Describe the picture you want'}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <input
              type="text"
              className="fedda-input w-full rounded-lg px-3 py-2 text-sm text-white/90"
              value={text}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </div>
      );
    }

    // --------------------------------------------------------------- number
    case 'number': {
      const num = typeof value === 'number' ? value : Number(field.default ?? 0);
      const isSeed = field.role === 'seed';

      // A slider needs a finite, meaningful range. `seed` is declared 0 to
      // 2^64-1, which is not something to drag - so it keeps the number box and
      // gains a dice instead. The node's own bounds decide which it gets.
      const slidable = !isSeed
        && typeof field.min === 'number'
        && typeof field.max === 'number'
        && field.max - field.min <= 100000;

      return (
        <div className="cockpit-panel">
          <Head label={field.label} hint={String(num)} />
          {slidable ? (
            <input
              type="range"
              className="cockpit-range"
              min={field.min}
              max={field.max}
              step={field.step ?? 1}
              value={num}
              disabled={disabled}
              onChange={(e) => onChange(Number(e.target.value))}
            />
          ) : (
            <div className={cn('flex items-center gap-2', isSeed && 'cockpit-seed-row')}>
              <input
                type="number"
                className="fedda-input w-full rounded-lg px-3 py-2 text-sm text-white/90"
                min={field.min}
                max={field.max}
                step={field.step ?? 1}
                value={num}
                disabled={disabled}
                onChange={(e) => onChange(Number(e.target.value))}
              />
              {isSeed && (
                <button
                  type="button"
                  title="Random seed"
                  disabled={disabled}
                  className="px-2.5 py-2 shrink-0"
                  onClick={() => onChange(Math.floor(Math.random() * SEED_MAX))}
                >
                  <Dice5 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      );
    }

    // --------------------------------------------------------------- select
    case 'select': {
      const options = choices(field.options);
      return (
        <div className="cockpit-panel">
          <Head label={field.label} hint={`${options.length}`} />
          <select
            className="fedda-input w-full rounded-lg px-3 py-2 text-sm text-white/90"
            value={String(value ?? field.default ?? '')}
            disabled={disabled}
            onChange={(e) => {
              // Round-trip through the option list so a numeric value stays a
              // number: a select's value is always a string, and the graph slot
              // it feeds may be an INT.
              const hit = options.find((o) => String(o.value) === e.target.value);
              onChange((hit ? hit.value : e.target.value) as FieldValue);
            }}
          >
            {options.map((option) => (
              <option key={String(option.value)} value={String(option.value)} className="bg-[#0b0b0d]">
                {option.label}
              </option>
            ))}
          </select>
        </div>
      );
    }

    // ---------------------------------------------------------------- chips
    case 'chips': {
      const options = choices(field.options);
      const current = String(value ?? field.default ?? '');
      return (
        <div className="cockpit-panel">
          <Head label={field.label} />
          <div className="cockpit-preset-chips">
            {options.map((option) => (
              <button
                key={String(option.value)}
                type="button"
                disabled={disabled}
                onClick={() => onChange(option.value as FieldValue)}
                className={cn(String(option.value) === current && 'is-active')}
                aria-pressed={String(option.value) === current}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      );
    }

    // --------------------------------------------------------------- toggle
    case 'toggle': {
      const on = Boolean(value ?? field.default);
      return (
        <div className="cockpit-panel">
          <Head label={field.label} />
          <div className="cockpit-preset-chips">
            {/* The node names its own states, so a toggle can read
                "bbox / crop_region" rather than a meaningless on/off. */}
            <button
              type="button"
              disabled={disabled}
              aria-pressed={on}
              className={cn(on && 'is-active')}
              onClick={() => onChange(true)}
            >
              {field.label_on || 'On'}
            </button>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={!on}
              className={cn(!on && 'is-active')}
              onClick={() => onChange(false)}
            >
              {field.label_off || 'Off'}
            </button>
          </div>
        </div>
      );
    }

    // ----------------------------------------------------------------- file
    case 'file': {
      const name = typeof value === 'string' ? value : '';
      const busy = disabled || uploading;
      return (
        <div className="cockpit-panel">
          <Head label={field.label} hint={field.required ? 'required' : undefined} />

          {preview && (
            <img
              src={preview}
              alt=""
              className="mb-2 max-h-40 w-full rounded-lg border border-white/10 object-contain"
            />
          )}

          <div
            className="cockpit-upload-row"
            // Dropping is how anyone with the file already open expects this to
            // work; the button stays for everyone else.
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file && !busy) void upload(file);
            }}
          >
            <button
              type="button"
              disabled={busy}
              className="fedda-btn-ghost inline-flex items-center gap-2 px-3 py-2 text-xs"
              onClick={() => fileRef.current?.click()}
            >
              {uploading
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Upload className="w-3.5 h-3.5" />}
              {uploading ? 'Uploading' : name ? 'Replace' : `Choose ${field.accept ?? 'file'}`}
            </button>
            <span className="text-[11px] text-white/45 truncate">
              {name || 'Nothing chosen - or drop one here'}
            </span>
            <input
              ref={fileRef}
              type="file"
              hidden
              accept={`${field.accept ?? 'image'}/*`}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
                // Cleared so choosing the same file twice fires onChange again,
                // which it otherwise would not.
                e.target.value = '';
              }}
            />
          </div>

          {field.mask && localUrl && (
            <button
              type="button"
              disabled={busy}
              className="fedda-btn-ghost mt-2 inline-flex items-center gap-2 px-3 py-2 text-xs"
              onClick={() => setMaskOpen(true)}
            >
              <Brush className="w-3.5 h-3.5" />
              {masked ? 'Edit mask' : 'Paint mask'}
            </button>
          )}

          {masked && (
            // Not a nicety. A canvas stores alpha premultiplied, so a pixel
            // written at alpha 0 keeps no colour - the picture under the mask
            // is gone and LoadImage flattens it to black. Below denoise 1.0
            // the sampler keeps a share of that black and hands it back.
            <p className="mt-2 text-[11px] leading-snug text-white/45">
              Masked areas lose their colour. Set <strong className="text-white/70">Denoise</strong> to
              1.0, or they come back dark.
            </p>
          )}

          {maskOpen && localUrl && (
            <MaskBrush
              imageUrl={localUrl}
              busy={uploading}
              onCancel={() => setMaskOpen(false)}
              onSave={async (file) => {
                await upload(file, true);
                setMasked(true);
                setMaskOpen(false);
              }}
            />
          )}

          {uploadError && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-amber-300">
              <AlertCircle className="h-3 w-3 shrink-0" /> {uploadError}
            </p>
          )}
        </div>
      );
    }

    // The LoRA panel needs the installed list, which the page fetches, so it is
    // rendered there rather than here.
    case 'lora':
      return null;

    default:
      return null;
  }
};
