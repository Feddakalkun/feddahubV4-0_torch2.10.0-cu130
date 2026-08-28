export const inputBase =
  'w-full rounded-lg border border-white/10 bg-black/35 px-3 py-2 text-sm text-zinc-100 outline-none transition focus:border-white/25 placeholder:text-zinc-600';
export const smallLabel = 'text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500';
export const panel =
  'rounded-xl border border-white/10 bg-[#09090b] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]';

export function cn(...items: Array<string | false | null | undefined>): string {
  return items.filter(Boolean).join(' ');
}
