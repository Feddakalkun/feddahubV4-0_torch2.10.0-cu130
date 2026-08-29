import { useState } from 'react';
import { Info } from 'lucide-react';

/**
 * A hint that appears the moment you point at it.
 *
 * Not the native `title` attribute: the browser waits about a second before
 * showing one, which is long enough that nobody discovers it. A control whose
 * explanation only arrives if you hover and then wait is, in practice, an
 * unexplained control.
 *
 * Meant to be spread across the interface over time, so it takes a string and
 * nothing else - a place to put the sentence someone would otherwise have to
 * learn by running a job and waiting.
 */
export function InfoTip({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <span
      className={`relative inline-flex items-center ${className ?? ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        // Focusable so the hint is reachable without a mouse, but not a
        // control - it does nothing when pressed.
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => e.preventDefault()}
        aria-label={text}
        className="text-zinc-600 transition-colors hover:text-zinc-300 focus:text-zinc-300 focus:outline-none"
      >
        <Info className="h-3 w-3" />
      </button>

      {open && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-56 -translate-x-1/2
                     rounded-lg border border-white/10 bg-[#14161a] px-2.5 py-1.5 text-[11px]
                     font-normal normal-case leading-relaxed tracking-normal text-zinc-300 shadow-xl"
        >
          {text}
        </span>
      )}
    </span>
  );
}
