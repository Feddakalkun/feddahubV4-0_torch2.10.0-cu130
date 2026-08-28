import type { LucideIcon } from 'lucide-react';
import { ArrowRight, Hammer } from 'lucide-react';
import { cn } from '../../lib/styles';

/**
 * One card, and one grid of them. Used at every level of the app.
 *
 * v3 had a different component per level - `RichHome` for the landing page,
 * `SectionCards` for the area below it, a third arrangement inside each studio
 * - and they drifted, because nothing forced them to agree. Three looks for one
 * idea: here are some things, pick one.
 *
 * So there is one card here and one grid, and the levels differ only in what
 * they are handed. A new level costs a list, not a component.
 */

export interface CardItem {
  id: string;
  label: string;
  description?: string;
  Icon?: LucideIcon;
  /** "6 workflows" under the title, when the card opens onto more cards. */
  count?: number;
  countLabel?: string;
  /** Not built yet - shown, but marked. */
  wip?: boolean;
}

interface CardProps {
  item: CardItem;
  onSelect: (id: string) => void;
}

const Card = ({ item, onSelect }: CardProps) => {
  const { Icon } = item;
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className={cn(
        'group relative flex min-h-0 flex-col justify-between overflow-hidden rounded-xl',
        'border border-white/10 bg-gradient-to-b from-white/[0.045] to-white/[0.015]',
        'p-5 text-left transition',
        'hover:border-white/20 hover:from-white/[0.075] hover:to-white/[0.03]',
        'focus:outline-none focus-visible:border-white/30',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        {Icon && (
          <span className="rounded-lg border border-white/10 bg-black/25 p-2">
            <Icon className="h-4 w-4 text-white/70" />
          </span>
        )}
        {item.wip && (
          <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-300">
            <Hammer className="h-3 w-3" /> Not yet
          </span>
        )}
      </div>

      <div className="mt-4">
        <h3 className="text-base font-semibold tracking-tight text-white">{item.label}</h3>
        {item.description && (
          <p className="mt-1.5 text-[13px] leading-snug text-white/45">{item.description}</p>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/30">
          {item.count !== undefined
            ? `${item.count} ${item.countLabel ?? (item.count === 1 ? 'workflow' : 'workflows')}`
            : 'Open'}
        </span>
        <ArrowRight className="h-4 w-4 text-white/25 transition group-hover:translate-x-0.5 group-hover:text-white/60" />
      </div>
    </button>
  );
};

interface CardGridProps {
  items: CardItem[];
  onSelect: (id: string) => void;
  /** Small line above the heading - where you are. */
  kicker?: string;
  title?: string;
  /** Rendered above the grid, e.g. the Hugging Face token reminder. */
  banner?: React.ReactNode;
  empty?: React.ReactNode;
}

export const CardGrid = ({ items, onSelect, kicker, title, banner, empty }: CardGridProps) => (
  <div className="h-full overflow-y-auto custom-scrollbar">
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      {banner && <div className="mb-5 empty:hidden">{banner}</div>}

      {(kicker || title) && (
        <div className="mb-6">
          {kicker && <div className="fedda-kicker">{kicker}</div>}
          {title && (
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-white">{title}</h2>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-8 text-center text-sm text-white/40">
          {empty ?? 'Nothing installed here yet.'}
        </div>
      ) : (
        // Three across on a wide screen, two on a laptop, one on a narrow
        // window. Fixed counts rather than auto-fit: a card that stretches to
        // half the screen stops reading as one of a set.
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <Card key={item.id} item={item} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  </div>
);
