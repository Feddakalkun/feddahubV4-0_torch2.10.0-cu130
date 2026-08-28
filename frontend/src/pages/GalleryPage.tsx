import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, Images, RefreshCw, Video } from 'lucide-react';
import { loadStoredMedia, triggerMediaDownload, type MediaItem } from '../utils/mediaStore';

type Filter = 'all' | 'image' | 'video';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
];

export const GalleryPage = () => {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [filter, setFilter] = useState<Filter>('all');

  const refresh = () => setItems(loadStoredMedia());

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 2500);
    const onFocus = () => refresh();
    const onStorage = () => refresh();
    const onGallery = () => refresh();
    window.addEventListener('focus', onFocus);
    window.addEventListener('storage', onStorage);
    window.addEventListener('fedda:gallery-updated', onGallery as EventListener);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('fedda:gallery-updated', onGallery as EventListener);
    };
  }, []);

  const counts = useMemo(() => ({
    all: items.length,
    image: items.filter((item) => item.kind === 'image').length,
    video: items.filter((item) => item.kind === 'video').length,
  }), [items]);

  const visible = useMemo(
    () => items.filter((item) => filter === 'all' || item.kind === filter),
    [items, filter],
  );

  return (
    <div className="h-full overflow-y-auto custom-scrollbar bg-[#07080d] px-6 py-6">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <div className="flex flex-col gap-4 border-b border-white/10 pb-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="v14-kicker text-white/45">Unified Gallery</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">Images and videos</h1>
            <p className="mt-2 text-sm text-slate-500">All outputs captured from FEDDA workflows, sorted newest first.</p>
          </div>
          <button onClick={refresh} className="v15-home-btn inline-flex items-center gap-2 self-start md:self-auto">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              onClick={() => setFilter(item.id)}
              className={`rounded-lg border px-4 py-2 text-xs font-semibold transition ${filter === item.id ? 'border-white bg-white text-black' : 'border-white/10 bg-white/[0.03] text-white/55 hover:text-white'}`}
            >
              {item.label} <span className="ml-1 opacity-60">{counts[item.id]}</span>
            </button>
          ))}
        </div>

        {visible.length === 0 ? (
          <div className="flex h-[58vh] items-center justify-center rounded-lg border border-white/10 bg-black/30 text-slate-500">
            No outputs yet.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {visible.map((item, idx) => (
              <article key={`${item.url}-${idx}`} className="overflow-hidden rounded-lg border border-white/10 bg-black/30">
                <div className={item.kind === 'video' ? 'aspect-video bg-black' : 'aspect-square bg-black'}>
                  {item.kind === 'video' ? (
                    <video src={item.url} className="h-full w-full object-cover" controls playsInline />
                  ) : (
                    <img src={item.url} alt={`gallery-${idx}`} className="h-full w-full object-cover" loading="lazy" />
                  )}
                </div>
                <div className="space-y-2 p-3">
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                    {item.kind === 'video' ? <Video className="h-3 w-3" /> : <Images className="h-3 w-3" />}
                    <span className="truncate">{item.source}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')} className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/10 px-2 py-1.5 text-[11px] text-slate-200 hover:bg-white/5">
                      <ExternalLink className="h-3 w-3" /> Open
                    </button>
                    <button onClick={() => triggerMediaDownload(item.url, `fedda-${item.kind}-${idx + 1}.${item.kind === 'video' ? 'mp4' : 'png'}`)} className="inline-flex items-center justify-center gap-1 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-2 py-1.5 text-[11px] text-cyan-200 hover:bg-cyan-500/20">
                      <Download className="h-3 w-3" /> Download
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
