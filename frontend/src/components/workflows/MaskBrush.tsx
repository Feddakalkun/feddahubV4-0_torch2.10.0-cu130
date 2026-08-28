import { useEffect, useRef, useState } from 'react';
import { Eraser, Loader2, RotateCcw, Undo2, X } from 'lucide-react';

/**
 * Paint the area to inpaint, and hand back the picture with that area punched
 * out of the alpha channel.
 *
 * That inversion is the whole contract and it is easy to get backwards:
 * ComfyUI's LoadImage returns MASK as `1 - alpha`, so the region to be
 * regenerated must end up **transparent**, not opaque. A workflow reading
 * LoadImage's MASK output therefore needs an RGBA PNG whose painted area has
 * alpha 0 - which is what the editor's own clipspace files contain.
 *
 * What that costs, and it is not optional: a browser canvas stores alpha
 * premultiplied, so a pixel written at alpha 0 keeps no colour. The picture
 * under the mask is gone, and LoadImage flattens it to black - measured on a
 * real upload, RGB 8,7,6 under the mask against 130,121,113 outside. Any
 * consumer of this file must therefore regenerate the masked area outright
 * (denoise 1.0); a lower denoise keeps a share of black and returns it. Sending
 * the mask as its own file is the only way to keep those pixels.
 *
 * Two canvases rather than one: `base` holds the untouched picture, `paint`
 * holds the strokes. Compositing only at export means the brush can be undone
 * and resized without ever degrading the source pixels.
 */

interface Props {
  /** Displayed image. Same-origin or CORS-enabled, or the canvas taints and export fails. */
  imageUrl: string;
  /** Called with the RGBA PNG. The caller uploads it and uses the returned name. */
  onSave: (file: File) => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
}

export const MaskBrush = ({ imageUrl, onSave, onCancel, busy = false }: Props) => {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const paintRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  // Snapshots for undo, capped: a 2304x1536 mask is ~14 MB as ImageData, so an
  // unbounded stack is a memory leak disguised as a feature.
  const history = useRef<ImageData[]>([]);

  const [size, setSize] = useState(64);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const b = baseRef.current, p = paintRef.current;
      if (!b || !p) return;
      b.width = p.width = img.naturalWidth;
      b.height = p.height = img.naturalHeight;
      b.getContext('2d')?.drawImage(img, 0, 0);
      p.getContext('2d')?.clearRect(0, 0, p.width, p.height);
      history.current = [];
      setPainted(false);
      setReady(true);
    };
    img.onerror = () => setError('Could not load the image into the editor.');
    img.src = imageUrl;
  }, [imageUrl]);

  /** Canvas pixel coordinates for a pointer event, independent of CSS size. */
  const at = (e: React.PointerEvent) => {
    const p = paintRef.current!;
    const r = p.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * p.width,
      y: ((e.clientY - r.top) / r.height) * p.height,
    };
  };

  const pushHistory = () => {
    const p = paintRef.current;
    const ctx = p?.getContext('2d');
    if (!p || !ctx) return;
    history.current.push(ctx.getImageData(0, 0, p.width, p.height));
    if (history.current.length > 12) history.current.shift();
  };

  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ctx = paintRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = 'rgba(255,64,64,0.85)';
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  const onDown = (e: React.PointerEvent) => {
    if (!ready || busy) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    pushHistory();
    drawing.current = true;
    const pt = at(e);
    last.current = pt;
    stroke(pt, pt);            // a click with no drag must still mark a dot
    setPainted(true);
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drawing.current || !last.current) return;
    const pt = at(e);
    stroke(last.current, pt);
    last.current = pt;
  };

  const onUp = () => { drawing.current = false; last.current = null; };

  const undo = () => {
    const prev = history.current.pop();
    const ctx = paintRef.current?.getContext('2d');
    if (!ctx || !paintRef.current) return;
    if (prev) ctx.putImageData(prev, 0, 0);
    else ctx.clearRect(0, 0, paintRef.current.width, paintRef.current.height);
    // The stack, not whether a snapshot came back. The first stroke pushes an
    // empty canvas, so undoing it restores blank while `prev` is still truthy -
    // which left the mask "painted", the save button live, and an all-opaque
    // upload that inpaints nothing while reporting success.
    setPainted(history.current.length > 0);
  };

  const clear = () => {
    const p = paintRef.current;
    p?.getContext('2d')?.clearRect(0, 0, p.width, p.height);
    history.current = [];
    setPainted(false);
  };

  const save = async () => {
    const b = baseRef.current, p = paintRef.current;
    if (!b || !p) return;
    const out = document.createElement('canvas');
    out.width = b.width; out.height = b.height;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(b, 0, 0);
    // Punch the painted area out of the alpha channel. destination-out keeps the
    // picture and removes only where the brush has coverage, so a soft edge in
    // the stroke becomes a soft edge in the mask.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(p, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    const blob: Blob | null = await new Promise((r) => out.toBlob(r, 'image/png'));
    if (!blob) { setError('Could not export the mask.'); return; }
    await onSave(new File([blob], `mask-${Date.now()}.png`, { type: 'image/png' }));
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-[11px] font-black uppercase tracking-widest text-white/50">
          Paint what should change
        </span>
        <label className="flex items-center gap-2 text-[11px] text-white/60">
          Brush
          <input
            type="range" min={8} max={256} step={4}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            className="w-40"
          />
          <span className="w-8 font-mono text-white/40">{size}</span>
        </label>
        <button type="button" onClick={undo} disabled={!painted}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-[11px] text-white/70 transition hover:bg-white/[0.1] disabled:opacity-30">
          <Undo2 className="h-3.5 w-3.5" /> Undo
        </button>
        <button type="button" onClick={clear} disabled={!painted}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-[11px] text-white/70 transition hover:bg-white/[0.1] disabled:opacity-30">
          <Eraser className="h-3.5 w-3.5" /> Clear
        </button>

        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onCancel}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] text-white/50 transition hover:text-white">
            <X className="h-3.5 w-3.5" /> Cancel
          </button>
          <button type="button" onClick={save} disabled={!painted || busy || !ready}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/80 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-30">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            {busy ? 'Uploading…' : 'Use this mask'}
          </button>
        </div>
      </div>

      <div ref={wrapRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <div className="relative max-h-full max-w-full">
          <canvas ref={baseRef} className="max-h-[78vh] max-w-full rounded-lg" />
          <canvas
            ref={paintRef}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
            className="absolute inset-0 h-full w-full cursor-crosshair touch-none rounded-lg"
          />
        </div>
      </div>

      {error && <p className="mt-2 text-[11px] text-red-300">{error}</p>}
      {!painted && !error && (
        <p className="mt-2 text-[11px] text-white/35">
          Nothing is masked yet — the run would change nothing. Paint over the part you want replaced.
        </p>
      )}
    </div>
  );
};
