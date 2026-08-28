export type MediaKind = 'image' | 'video';

export interface MediaItem {
  url: string;
  source: string;
  kind: MediaKind;
}

const DEFAULT_MAX_ITEMS = 120;

const parseStringArray = (value: string | null): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v) => typeof v === 'string' && v.trim().length > 0);
  } catch {
    return [];
  }
};

export const mediaSourceIsVideo = (source: string, url: string): boolean => {
  const s = source.toLowerCase();
  const u = url.toLowerCase();
  return (
    s.includes('video') ||
    s.includes('vid') ||
    s.includes('wan') ||
    s.includes('ltx') ||
    u.includes('.mp4') ||
    u.includes('.webm') ||
    u.includes('.mov') ||
    u.includes('type=output') && (s.includes('wan') || s.includes('ltx'))
  );
};

export const loadStoredMedia = (maxItems = DEFAULT_MAX_ITEMS): MediaItem[] => {
  if (typeof window === 'undefined') return [];
  const keys = Object.keys(window.localStorage).filter(
    (key) => key.startsWith('gallery_') || key.endsWith('_history'),
  );
  const seen = new Set<string>();
  const merged: MediaItem[] = [];

  keys.forEach((key) => {
    const source = key.replace(/^gallery_/, '').replace(/_history$/, '');
    const urls = parseStringArray(window.localStorage.getItem(key));
    urls.forEach((url) => {
      if (seen.has(url)) return;
      seen.add(url);
      merged.push({
        url,
        source,
        kind: mediaSourceIsVideo(source, url) ? 'video' : 'image',
      });
    });
  });

  return merged.slice(0, maxItems);
};

export const triggerMediaDownload = (url: string, suggestedName: string): void => {
  const link = document.createElement('a');
  link.href = url;
  link.download = suggestedName;
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

export const saveAudioToGallery = (url: string, source = 'zonos') => {
  if (typeof window === 'undefined' || !url) return;
  const key = `gallery_${source}`;
  try {
    const existing: string[] = JSON.parse(localStorage.getItem(key) || '[]');
    if (!existing.includes(url)) {
      const updated = [url, ...existing].slice(0, 50);
      localStorage.setItem(key, JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('fedda:gallery-updated'));
    }
  } catch {}
};
