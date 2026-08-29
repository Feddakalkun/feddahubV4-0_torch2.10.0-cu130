import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { usePersistentState } from '../../hooks/usePersistentState';

/**
 * A step-by-step walkthrough that points at real controls.
 *
 * A page like Reel Machine is four decisions deep before anything happens, and
 * every one of them is obvious only once you already know the answer. Prose in
 * a panel does not fix that - it gets skipped, and it goes stale the moment a
 * control moves. Pointing at the control itself cannot go stale in the same
 * way: if the anchor disappears the step says so instead of lying.
 *
 * Steps name a `data-tour` attribute rather than a CSS class or a DOM path, so
 * restyling a section cannot silently break the tour. A step whose anchor is
 * missing - a control behind a toggle, a section that only renders once a file
 * is chosen - still shows, centred, rather than being skipped: what it explains
 * is usually why the control is not there yet.
 */

export interface TourStep {
  /** Value of the target's `data-tour` attribute. Omit for a centred step. */
  target?: string;
  title: string;
  body: string;
  /** Preferred side. Flipped automatically when it would leave the viewport. */
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

interface Props {
  steps: TourStep[];
  /** Remembers that this tour has been finished. Also the replay handle. */
  storageKey: string;
  /** Start automatically the first time, before it has ever been finished. */
  auto?: boolean;
  /** Controlled open, for a replay button. */
  open?: boolean;
  onClose?: () => void;
}

const CARD_W = 340;
const GAP = 14;
const PAD = 8;

interface Box { top: number; left: number; width: number; height: number }

export const Tour = ({ steps, storageKey, auto = true, open, onClose }: Props) => {
  const [seen, setSeen] = usePersistentState(`tour_seen_${storageKey}`, false);
  const [selfOpen, setSelfOpen] = useState(false);
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box | null>(null);

  const isOpen = open ?? selfOpen;

  // First visit only. Delayed a frame so the page has laid out - measuring an
  // anchor that has not been positioned yet puts the card in the corner.
  useEffect(() => {
    if (!auto || seen || open !== undefined) return;
    const t = window.setTimeout(() => { setI(0); setSelfOpen(true); }, 400);
    return () => window.clearTimeout(t);
  }, [auto, seen, open]);

  const step = steps[i];

  const measure = useCallback(() => {
    if (!step?.target) { setBox(null); return; }
    const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    if (!el) { setBox(null); return; }
    const r = el.getBoundingClientRect();
    setBox({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 });
  }, [step]);

  // Bring the anchor into view before measuring it, or a step near the bottom
  // of a long page spotlights something off-screen.
  useLayoutEffect(() => {
    if (!isOpen || !step) return;
    const el = step.target
      ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
      : null;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    measure();
    const t = window.setTimeout(measure, 350);   // after the smooth scroll settles
    return () => window.clearTimeout(t);
  }, [isOpen, step, measure]);

  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [isOpen, measure]);

  const finish = useCallback(() => {
    setSeen(true);
    setSelfOpen(false);
    setI(0);
    onClose?.();
  }, [onClose, setSeen]);

  const next = useCallback(() => {
    if (i >= steps.length - 1) finish();
    else setI((n) => n + 1);
  }, [i, steps.length, finish]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, finish, next]);

  if (!isOpen || !step) return null;

  // Where the card goes. Centred with no anchor; otherwise beside the anchor on
  // the requested side, flipped when that side has no room.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let cardStyle: React.CSSProperties;

  if (!box) {
    // Same width as an anchored card. Without it the centred one sized to its
    // text and came out half again as wide, so the opening step did not look
    // like the four that follow it.
    cardStyle = { top: '50%', left: '50%', width: CARD_W, transform: 'translate(-50%, -50%)' };
  } else {
    const want = step.placement ?? 'bottom';
    const roomBelow = vh - (box.top + box.height);
    const side = want === 'bottom' && roomBelow < 190 ? 'top'
      : want === 'top' && box.top < 190 ? 'bottom'
      : want;

    let top: number;
    let left = box.left + box.width / 2 - CARD_W / 2;

    if (side === 'top') top = box.top - GAP;
    else if (side === 'bottom') top = box.top + box.height + GAP;
    else {
      top = box.top + box.height / 2;
      left = side === 'left' ? box.left - CARD_W - GAP : box.left + box.width + GAP;
    }

    left = Math.max(12, Math.min(left, vw - CARD_W - 12));
    cardStyle = {
      top,
      left,
      width: CARD_W,
      transform: side === 'top' ? 'translateY(-100%)'
        : side === 'left' || side === 'right' ? 'translateY(-50%)'
        : undefined,
    };
  }

  return createPortal(
    <div className="fixed inset-0 z-[100]">
      {/* The dimming is one enormous shadow around the anchor, so the anchor
          itself keeps its real colours instead of being redrawn over. */}
      {box ? (
        <div
          className="pointer-events-none absolute rounded-xl ring-2 ring-violet-400/70 transition-all duration-200"
          style={{
            top: box.top, left: box.left, width: box.width, height: box.height,
            boxShadow: '0 0 0 9999px rgba(3,3,6,0.78)',
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-[#030306]/78" />
      )}

      <div
        className="absolute rounded-2xl border border-white/12 bg-[#0b0c12] p-4 shadow-2xl"
        style={cardStyle}
      >
        <button
          type="button"
          onClick={finish}
          aria-label="Close the walkthrough"
          className="absolute right-2.5 top-2.5 text-white/25 transition hover:text-white/70"
        >
          <X className="h-3.5 w-3.5" />
        </button>

        <p className="mb-1 text-[9px] font-black uppercase tracking-[0.22em] text-violet-300/70">
          Step {i + 1} of {steps.length}
        </p>
        <h3 className="mb-1.5 pr-5 text-sm font-bold text-white">{step.title}</h3>
        <p className="text-[12px] leading-relaxed text-white/55">{step.body}</p>

        <div className="mt-3.5 flex items-center gap-1.5">
          {steps.map((_, n) => (
            <span
              key={n}
              className={
                n === i ? 'h-1 w-4 rounded-full bg-violet-400'
                        : 'h-1 w-1 rounded-full bg-white/15'
              }
            />
          ))}
          <div className="flex-1" />
          {i > 0 && (
            <button
              type="button"
              onClick={() => setI((n) => n - 1)}
              className="rounded-lg px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-widest text-white/40 transition hover:text-white/80"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={next}
            className="rounded-lg bg-violet-600 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-white transition hover:bg-violet-500"
          >
            {i === steps.length - 1 ? 'Got it' : 'Next'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
