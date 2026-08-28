/**
 * GlobalOutputStrip — ONE shared "recent generations" bar on every page.
 * Collects every finished image/video from any workflow (via the app-level
 * ComfyExecution websocket) into a single persisted history, so you can
 * generate an image on one page, switch to a video page, and drag it straight
 * into an upload slot (UploadSlot accepts dragged URLs). Collapsible.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, Images, Play, Trash2, X } from 'lucide-react';
import { useComfyExecution } from '../../contexts/ComfyExecutionContext';
import { usePersistentState } from '../../hooks/usePersistentState';
import { comfyService } from '../../services/comfyService';

/**
 * `t` is when we saw it, in ms.
 *
 * There was no time on an item at all, so "recent" meant nothing more than
 * insertion order - and a single run inserts its images in ComfyUI's node
 * order, which is not time order. A dual-LoRA run reports
 * ['main_before_detail', 'final_refined'], so the *unfinished* image took the
 * newest slot. Items saved before this existed have no `t` and sort last,
 * which is where they belong.
 */
type StripItem = { u: string; v?: boolean; t?: number };

const VIDEO_RE = /\.(mp4|webm|mov|gif|webp)($|\?)/i;
const MAX_ITEMS = 40;

export const GlobalOutputStrip = () => {
  const { state, previewUrl, lastOutputImages, lastOutputVideos, outputReadyCount } = useComfyExecution();
  const [items, setItems] = usePersistentState<StripItem[]>('global_gen_history', []);
  // Recent Generations opens closed for the same reason as the output pane:
  // on a fresh page it is a row of nothing, charged against the height the
  // controls need.
  const [open, setOpen] = usePersistentState<boolean>('global_strip_open', false);
  const [lightbox, setLightbox] = useState<StripItem | null>(null);

  // Accumulate every finished output (any page, any workflow) into one list.
  useEffect(() => {
    const t = Date.now();
    const imgs = lastOutputImages.map((f) => ({ u: comfyService.getImageUrl(f), t }));
    const vids = lastOutputVideos.map((f) => ({ u: comfyService.getImageUrl(f), v: true, t }));
    // Everything in one run shares a timestamp, so their order has to be
    // decided here. ComfyUI lists them in the order the nodes ran, so the last
    // one is the freshest - reversed, the finished image leads its own batch
    // instead of trailing the intermediate one it was made from.
    const fresh = [...imgs, ...vids].filter((n) => n.u).reverse();
    if (fresh.length === 0) return;
    setItems((prev) => {
      const seen = new Set(fresh.map((n) => n.u));
      // Array#sort is stable, so items sharing a timestamp keep the order above.
      return [...fresh, ...prev.filter((p) => !seen.has(p.u))]
        .sort((a, b) => (b.t ?? 0) - (a.t ?? 0))
        .slice(0, MAX_ITEMS);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputReadyCount]);

  const live = state === 'executing' && previewUrl ? previewUrl : null;
  const count = items.length + (live ? 1 : 0);

  const onDragStart = (e: React.DragEvent, url: string) => {
    const abs = url.startsWith('http') ? url : `${window.location.origin}${url}`;
    e.dataTransfer.setData('text/uri-list', abs);
    e.dataTransfer.setData('text/plain', abs);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div className="shrink-0 border-b border-white/5 bg-black/25 backdrop-blur-sm">
      {/* Header row — always visible */}
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-6 py-1.5 text-left"
      >
        <span className="flex items-center gap-2 text-[9px] font-black uppercase tracking-[0.2em] text-white/35">
          <Images className="h-3 w-3" />
          Recent generations
          <span className="font-mono text-white/25">{count}</span>
          {live && <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />}
        </span>
        <span className="flex items-center gap-3">
          {items.length > 0 && open && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); setItems([]); }}
              className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-white/20 hover:text-red-400"
              title="Clear history"
            >
              <Trash2 className="h-3 w-3" /> Clear
            </span>
          )}
          {open ? <ChevronUp className="h-3.5 w-3.5 text-white/25" /> : <ChevronDown className="h-3.5 w-3.5 text-white/25" />}
        </span>
      </button>

      {/* Thumb rail */}
      {open && count > 0 && (
        <div className="flex gap-2 overflow-x-auto px-6 pb-2 custom-scrollbar">
          {live && (
            <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-emerald-400/40">
              <img src={live} alt="live" className="h-full w-full object-cover" />
              <span className="absolute bottom-0 left-0 right-0 bg-emerald-500/80 text-center text-[7px] font-black uppercase tracking-widest text-black">live</span>
            </div>
          )}
          {items.map((it) => (
            <div key={it.u} className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-white/10 hover:border-white/30 transition-colors">
              {it.v ? (
                <video
                  src={it.u}
                  muted
                  loop
                  playsInline
                  draggable
                  onDragStart={(e) => onDragStart(e, it.u)}
                  onMouseEnter={(e) => void (e.currentTarget as HTMLVideoElement).play().catch(() => {})}
                  onMouseLeave={(e) => (e.currentTarget as HTMLVideoElement).pause()}
                  onClick={() => setLightbox(it)}
                  className="h-full w-full cursor-pointer object-cover"
                />
              ) : (
                <img
                  src={it.u}
                  alt=""
                  draggable
                  onDragStart={(e) => onDragStart(e, it.u)}
                  onClick={() => setLightbox(it)}
                  className="h-full w-full cursor-pointer object-cover"
                  loading="lazy"
                />
              )}
              {(it.v || VIDEO_RE.test(it.u)) && (
                <Play className="pointer-events-none absolute left-1 top-1 h-3 w-3 text-white/80 drop-shadow" />
              )}
              <button
                onClick={() => setItems((prev) => prev.filter((p) => p.u !== it.u))}
                className="absolute right-0.5 top-0.5 hidden rounded bg-black/70 p-0.5 text-white/70 hover:text-red-400 group-hover:block"
                title="Remove"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Lightbox — portalled to <body> so the strip's backdrop-blur/transform
          ancestor doesn't trap the fixed overlay inside the thin strip. */}
      {lightbox && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90 p-8"
          onClick={() => setLightbox(null)}
        >
          {lightbox.v ? (
            <video src={lightbox.u} controls autoPlay loop className="max-h-full max-w-full rounded-xl" onClick={(e) => e.stopPropagation()} />
          ) : (
            <img src={lightbox.u} alt="" className="max-h-full max-w-full rounded-xl object-contain" onClick={(e) => e.stopPropagation()} />
          )}
        </div>,
        document.body,
      )}
    </div>
  );
};
