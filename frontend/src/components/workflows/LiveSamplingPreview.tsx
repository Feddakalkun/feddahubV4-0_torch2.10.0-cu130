import type { ReactNode } from 'react';
import { ImageIcon, Loader2 } from 'lucide-react';

interface LiveSamplingPreviewProps {
  previewUrl?: string | null;
  isRunning?: boolean;
  hasOutput?: boolean;
  children?: ReactNode;
  emptyState?: ReactNode;
}

export function LiveSamplingPreview({
  previewUrl,
  isRunning = false,
  hasOutput = false,
  children,
  emptyState,
}: LiveSamplingPreviewProps) {
  if (previewUrl && isRunning) {
    return (
      <div className="flex min-h-[220px] items-center justify-center rounded-xl border border-white/10 bg-black/20 p-3">
        <div className="relative">
          <img
            src={previewUrl}
            alt="Generating…"
            className="max-h-[620px] rounded-lg border border-white/10 object-contain"
          />
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white/70">
            <Loader2 className="mr-1.5 inline h-3 w-3 animate-spin" />Generating
          </div>
        </div>
      </div>
    );
  }

  if (hasOutput) {
    return <>{children}</>;
  }

  if (emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div className="flex min-h-[220px] items-center justify-center rounded-xl border border-dashed border-white/10 bg-black/20 p-3">
      <div className="text-center text-white/35">
        <ImageIcon className="mx-auto mb-3 h-8 w-8 opacity-40" />
        <div className="text-sm font-semibold">No preview yet</div>
        <div className="mt-1 text-xs text-white/25">Generate once to see the live sampling preview here.</div>
      </div>
    </div>
  );
}
