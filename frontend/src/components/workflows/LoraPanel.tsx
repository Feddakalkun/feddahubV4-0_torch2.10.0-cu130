import { Plus } from 'lucide-react';
import { LoraCharacterCard } from '../ui/LoraCharacterCard';

export interface LoraEntry {
  name: string;
  strength: number;
}

export interface LoraSlot {
  key: string;
  label: string;
  options: string[];
  /** How many of `options` matched this slot's filter; they sort first. */
  matchCount?: number;
  value: LoraEntry;
  onChange: (next: LoraEntry) => void;
}

interface LoraPanelProps {
  title?: string;
  accent?: 'violet' | 'emerald';
  /** Named in the empty-state line, e.g. "no compatible FLUX LoRAs". */
  familyLabel?: string;
  getPreview?: (name: string) => string | null;
  /** Interchangeable LoRAs, grown and removed by the user. */
  stack?: {
    entries: LoraEntry[];
    onChange: (next: LoraEntry[]) => void;
    options: string[];
    matchCount?: number;
    limit?: number;
  };
  /** Slots that each mean something distinct and cannot be reordered. */
  slots?: LoraSlot[];
}

/**
 * The LoRA panel, for every workflow page.
 *
 * There were four of these. The cockpit had one inline, WorkflowPage rendered a
 * different one through LoraSelector, LoraStack was a third that nothing used,
 * and GeneratePersonPanel a fourth - so which LoRA controls a workflow got came
 * down to which page framework it happened to be built on, which is not a
 * design decision anyone made. Same job, four looks.
 *
 * WorkflowPage's own header records the last time this was fixed: "21 pages
 * each hand-arranged WorkflowShell and drifted: three output components, thirty
 * section titles for four concepts." That consolidation happened at the page
 * level, and a second page framework then grew beside it. This is the same fix
 * one level down - the section, not the page - so a page cannot drift by
 * choosing a base.
 *
 * Two modes, because there are honestly two cases. A **stack** is
 * interchangeable LoRAs the user adds to, which is most workflows. **Slots**
 * are positions that each mean something - WAN's high-noise and low-noise
 * passes, Z-Image's main and secondary - where adding a third is meaningless
 * and the order is not the user's to choose. Both draw the same card, so they
 * look like one feature with a constraint rather than two features.
 */
export const LoraPanel = ({
  title = 'Characters / LoRAs',
  accent = 'violet',
  familyLabel,
  getPreview,
  stack,
  slots,
}: LoraPanelProps) => {
  const limit = stack?.limit ?? 6;
  // An empty stack still shows one card: an empty panel with an Add button
  // reads as a feature that is switched off rather than one waiting for input.
  const entries = stack && stack.entries.length ? stack.entries : [{ name: '', strength: 1 }];
  const options = stack ? stack.options : (slots?.[0]?.options ?? []);
  const count = slots ? slots.length : entries.length;

  const update = (index: number, patch: Partial<LoraEntry>) => {
    if (!stack) return;
    const next = entries.map((e, i) => (i === index ? { ...e, ...patch } : e));
    stack.onChange(next);
  };

  return (
    <div className="cockpit-panel cockpit-lora-panel">
      <div className="cockpit-panel-head">
        <span>{title}</span>
        <span>{count}/{slots ? count : limit}</span>
      </div>

      {options.length === 0 && (
        <p className="cockpit-muted">
          No compatible {familyLabel ? `${familyLabel} ` : ''}LoRAs are installed yet.
          You can generate without one and add packs later.
        </p>
      )}

      <div className="cockpit-lora-grid">
        {slots
          ? slots.map((slot, index) => (
            <LoraCharacterCard
              key={slot.key}
              index={index}
              label={slot.label}
              value={slot.value.name}
              strength={slot.value.strength}
              options={slot.options}
              matchCount={slot.matchCount}
              previewUrl={getPreview?.(slot.value.name) ?? null}
              accent={accent}
              compact
              onChange={(name) => slot.onChange({ ...slot.value, name })}
              onStrengthChange={(strength) => slot.onChange({ ...slot.value, strength })}
            />
          ))
          : entries.map((entry, index) => (
            <LoraCharacterCard
              key={`lora-${index}`}
              index={index}
              value={entry.name}
              strength={entry.strength}
              options={stack?.options ?? []}
              matchCount={stack?.matchCount}
              previewUrl={getPreview?.(entry.name) ?? null}
              accent={accent}
              compact
              onChange={(name) => update(index, { name })}
              onStrengthChange={(strength) => update(index, { strength })}
              // The first card is the panel's resting state, so it has nothing
              // to remove itself down to.
              onRemove={index > 0
                ? () => stack?.onChange(entries.filter((_, i) => i !== index))
                : undefined}
            />
          ))}
      </div>

      {/* What is actually in circuit, at what strength. Worth stating plainly:
          a stack of collapsed dropdowns does not answer it at a glance. */}
      {(slots ? slots.map((s) => s.value) : entries).some((e) => e.name?.trim()) && (
        <div className="rounded-lg border border-white/[0.06] bg-black/25 px-2.5 py-2 text-[10px] font-semibold text-white/45">
          Active: {(slots ? slots.map((s) => s.value) : entries)
            .filter((e) => e.name?.trim())
            .map((e) => `${e.name.split(/[\\/]/).pop()} @ ${e.strength.toFixed(2)}`)
            .join(', ')}
        </div>
      )}

      {stack && (
        <button
          type="button"
          onClick={() => stack.onChange(
            entries.length >= limit ? entries : [...entries, { name: '', strength: 1 }],
          )}
          disabled={entries.length >= limit}
          className="cockpit-add-lora"
        >
          <Plus className="h-3 w-3" /> Add LoRA
        </button>
      )}
    </div>
  );
};
