/**
 * Carried over from v3 unchanged. It was already right: self-contained, and it
 * asks ComfyUI for the expensive answers rather than guessing them.
 *
 * The only reason it needed thinking about at all is that v4 renders every
 * workflow from one declaration-driven page, and a storyboard cannot be
 * described as a list of fields. WorkflowPage takes three hooks now -
 * extraTop, extraParams, hideKeys - so this lives above the generated controls
 * and owns the three inputs it drives, without a second renderer or a second
 * submit path.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Flag, Film, Music, Image as ImageIcon } from 'lucide-react';

/**
 * The Director's timeline: three tracks you drag on and drop files onto.
 *
 * The node ships its own editor - thirteen thousand lines of it - and this is
 * not a copy of it. What it does copy is the part that matters: length is
 * something you take hold of rather than a number you type, and a file becomes
 * a clip by being dropped where it belongs.
 *
 * The expensive work is left to the node, which already exposes it over HTTP
 * through ComfyUI. Waveforms come from /minimax_director_get_audio and video
 * durations from /minimax_director/probe_video, so a dropped clip arrives on
 * the track at its real length instead of a guess. Vite proxies /comfy to
 * ComfyUI, which is also where the thumbnails come from.
 *
 * The two kinds of track behave differently on purpose. Shots on the main track
 * are a storyboard - contiguous, in order, no gaps - so dragging one moves it in
 * the running order and dragging its edge changes how long it lasts. Reference
 * clips are free: they sit at a time, and both edges trim.
 */

export type Segment = {
  id: string;
  prompt: string;
  length: number;
  type: 'text' | 'image';
  imageFile?: string;
  fileName?: string;
  isEndFrame?: boolean;
};

export type Clip = {
  id: string;
  file: string;
  start: number;
  length: number;
  peaks?: number[];
};

const MIN_FRAMES = 5;

const viewUrl = (f: string) =>
  `/comfy/view?filename=${encodeURIComponent(f)}&subfolder=&type=input`;

/** Waveform for a clip already uploaded to ComfyUI's input folder. */
export const fetchPeaks = async (filename: string): Promise<number[] | undefined> => {
  try {
    const r = await fetch(`/comfy/minimax_director_get_audio?filename=${encodeURIComponent(filename)}`);
    const d = await r.json();
    return Array.isArray(d?.peaks) ? d.peaks : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Real duration in seconds, asked of the node rather than of a <video> element.
 * The browser refuses HEVC, ProRes and 10-bit footage that renders perfectly
 * well, and a clip that lands on the track at the wrong length is worse than
 * one that takes a moment to arrive.
 */
export const probeVideoSeconds = async (filename: string): Promise<number | undefined> => {
  try {
    const r = await fetch('/comfy/minimax_director/probe_video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: filename }),
    });
    const d = await r.json();
    const s = Number(d?.duration ?? d?.seconds);
    return Number.isFinite(s) && s > 0 ? s : undefined;
  } catch {
    return undefined;
  }
};

type Kind = 'shots' | 'motion' | 'audio';

type DragState = {
  kind: Kind;
  index: number;
  mode: 'move' | 'resize-end' | 'resize-start';
  startX: number;
  origin: { start: number; length: number };
  pxPerFrame: number;
};

interface Props {
  segments: Segment[];
  setSegments: (fn: (s: Segment[]) => Segment[]) => void;
  motion: Clip[];
  setMotion: (fn: (c: Clip[]) => Clip[]) => void;
  audio: Clip[];
  setAudio: (fn: (c: Clip[]) => Clip[]) => void;
  fps: number;
  selected: number;
  setSelected: (i: number) => void;
  /** Uploads a dropped file and resolves to the name ComfyUI knows it by. */
  onUpload: (file: File) => Promise<string | null>;
  refsOn: boolean;
}

export const DirectorTimeline = ({
  segments, setSegments, motion, setMotion, audio, setAudio,
  fps, selected, setSelected, onUpload, refsOn,
}: Props) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<DragState | null>(null);
  const [dropping, setDropping] = useState<Kind | null>(null);
  const [busy, setBusy] = useState(false);

  const total = Math.max(1, segments.reduce((n, s) => n + Math.max(1, s.length), 0));

  // Shots are laid end to end; a start is just what came before it.
  const starts: number[] = [];
  segments.reduce((acc, s) => { starts.push(acc); return acc + Math.max(1, s.length); }, 0);

  const pct = (frames: number) => `${(frames / total) * 100}%`;

  // ---------------------------------------------------------------- dragging
  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const deltaFrames = Math.round((e.clientX - d.startX) / d.pxPerFrame);
    if (!deltaFrames) return;

    if (d.kind === 'shots') {
      if (d.mode === 'resize-end') {
        // A cut moves; the film does not get longer. Whatever this shot gains
        // comes out of the one after it, so the clip stays a length H3 renders.
        setSegments((s) => {
          const next = d.index + 1;
          if (next >= s.length) return s;
          const room = s[next].length - MIN_FRAMES;
          const want = d.origin.length + deltaFrames - s[d.index].length;
          const move = Math.max(-(s[d.index].length - MIN_FRAMES), Math.min(want, room));
          if (!move) return s;
          return s.map((seg, i) =>
            i === d.index ? { ...seg, length: seg.length + move }
            : i === next ? { ...seg, length: seg.length - move }
            : seg);
        });
        d.startX = e.clientX;
        d.origin = { ...d.origin, length: d.origin.length + deltaFrames };
        return;
      }
      // Moving a shot means changing its place in the running order. Swap when
      // the pointer has travelled past the neighbour's half-way point.
      const dir = deltaFrames > 0 ? 1 : -1;
      const neighbour = d.index + dir;
      if (neighbour < 0 || neighbour >= segments.length) return;
      if (Math.abs(deltaFrames) < segments[neighbour].length / 2) return;
      setSegments((s) => {
        const copy = [...s];
        [copy[d.index], copy[neighbour]] = [copy[neighbour], copy[d.index]];
        return copy;
      });
      setSelected(neighbour);
      d.index = neighbour;
      d.startX = e.clientX;
      return;
    }

    const setter = d.kind === 'motion' ? setMotion : setAudio;
    setter((cs) => cs.map((c, i) => {
      if (i !== d.index) return c;
      if (d.mode === 'move') {
        return { ...c, start: Math.max(0, d.origin.start + deltaFrames) };
      }
      if (d.mode === 'resize-end') {
        return { ...c, length: Math.max(MIN_FRAMES, d.origin.length + deltaFrames) };
      }
      // Trimming the front moves the start and shortens by the same amount, so
      // the far edge stays put.
      const shift = Math.min(deltaFrames, d.origin.length - MIN_FRAMES);
      return {
        ...c,
        start: Math.max(0, d.origin.start + shift),
        length: Math.max(MIN_FRAMES, d.origin.length - shift),
      };
    }));
  }, [segments, setSegments, setMotion, setAudio, setSelected]);

  const endDrag = useCallback(() => { drag.current = null; }, []);

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDrag);
    };
  }, [onPointerMove, endDrag]);

  const startDrag = (
    e: React.PointerEvent, kind: Kind, index: number, mode: DragState['mode'],
    origin: { start: number; length: number },
  ) => {
    e.stopPropagation();
    const width = trackRef.current?.clientWidth ?? 1;
    drag.current = { kind, index, mode, startX: e.clientX, origin, pxPerFrame: width / total };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  // ------------------------------------------------------------------ drops
  const handleDrop = async (e: React.DragEvent, kind: Kind) => {
    e.preventDefault();
    setDropping(null);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const name = await onUpload(file);
      if (!name) return;

      if (kind === 'shots') {
        // Where it landed decides which shot it belongs to.
        const box = trackRef.current?.getBoundingClientRect();
        const frame = box ? ((e.clientX - box.left) / box.width) * total : 0;
        let idx = segments.findIndex((s, i) => frame >= starts[i] && frame < starts[i] + s.length);
        if (idx < 0) idx = segments.length - 1;
        setSegments((s) => s.map((seg, i) =>
          i === idx ? { ...seg, imageFile: name, fileName: name, type: 'image' } : seg));
        setSelected(idx);
        return;
      }

      const id = `c${Math.random().toString(36).slice(2, 9)}`;
      if (kind === 'motion') {
        const secs = await probeVideoSeconds(name);
        const length = Math.max(MIN_FRAMES, Math.round((secs ?? 3) * fps));
        setMotion((cs) => [...cs, { id, file: name, start: 0, length }]);
      } else {
        const peaks = await fetchPeaks(name);
        setAudio((cs) => [...cs, { id, file: name, start: 0, length: Math.min(total, fps * 3), peaks }]);
      }
    } finally {
      setBusy(false);
    }
  };

  const dropProps = (kind: Kind) => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDropping(kind); },
    onDragLeave: () => setDropping((k) => (k === kind ? null : k)),
    onDrop: (e: React.DragEvent) => void handleDrop(e, kind),
  });

  const ring = (kind: Kind) =>
    dropping === kind ? 'ring-1 ring-white/40' : '';

  const clipTrack = (
    kind: 'motion' | 'audio', clips: Clip[],
    setClips: (fn: (c: Clip[]) => Clip[]) => void, colour: string, Icon: typeof Film,
  ) => (
    <div
      {...dropProps(kind)}
      className={`relative mt-1 h-7 overflow-hidden rounded bg-black/30 ${ring(kind)}`}
    >
      {clips.length === 0 && (
        <div className="pointer-events-none flex h-full items-center gap-1.5 px-2 text-[10px] text-white/25">
          <Icon className="h-3 w-3" />
          drop {kind === 'motion' ? 'a video to copy motion from' : 'audio to match'}
        </div>
      )}
      {clips.map((c, i) => (
        <div
          key={c.id}
          onPointerDown={(e) => startDrag(e, kind, i, 'move', { start: c.start, length: c.length })}
          className={`group absolute inset-y-0 cursor-grab rounded ${colour} active:cursor-grabbing`}
          style={{ left: pct(c.start), width: pct(c.length) }}
          title={c.file}
        >
          {c.peaks && c.peaks.length > 1 && (
            <svg className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none"
                 viewBox={`0 0 ${c.peaks.length} 2`}>
              <polyline
                points={c.peaks.map((p, x) => `${x},${1 - Math.min(1, Math.abs(p))} ${x},${1 + Math.min(1, Math.abs(p))}`).join(' ')}
                fill="none" stroke="currentColor" strokeOpacity="0.55" strokeWidth="0.06"
              />
            </svg>
          )}
          <span className="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 truncate
                           pr-3 text-[9px] text-white/70">
            {c.file}
          </span>
          <span
            onPointerDown={(e) => startDrag(e, kind, i, 'resize-start', { start: c.start, length: c.length })}
            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/0 group-hover:bg-white/30"
          />
          <span
            onPointerDown={(e) => startDrag(e, kind, i, 'resize-end', { start: c.start, length: c.length })}
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/0 group-hover:bg-white/30"
          />
          <button
            type="button"
            onClick={() => setClips((cs) => cs.filter((_, j) => j !== i))}
            className="absolute right-1 top-1/2 hidden -translate-y-1/2 text-[9px] text-white/50
                       hover:text-white group-hover:block"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <div className="select-none">
      {/* main track: the storyboard */}
      <div
        ref={trackRef}
        {...dropProps('shots')}
        className={`relative flex h-12 gap-[2px] overflow-hidden rounded-md bg-black/30 p-[2px] ${ring('shots')}`}
      >
        {segments.map((s, i) => (
          <div
            key={s.id}
            onPointerDown={(e) => startDrag(e, 'shots', i, 'move', { start: starts[i], length: s.length })}
            onClick={() => setSelected(i)}
            style={{
              flexGrow: Math.max(1, s.length),
              backgroundImage: s.imageFile ? `url(${viewUrl(s.imageFile)})` : undefined,
            }}
            className={`group relative flex min-w-0 cursor-grab items-center justify-center rounded-[3px]
              bg-contain bg-center bg-no-repeat text-[10px] font-semibold transition
              active:cursor-grabbing ${
              i === selected
                ? 'ring-1 ring-white/50'
                : 'ring-1 ring-transparent hover:ring-white/20'} ${
              s.imageFile ? 'text-white' : 'bg-white/[0.07] text-white/55'}`}
            title={s.prompt || `Shot ${i + 1}`}
          >
            {s.imageFile && <span className="absolute inset-0 rounded-[3px] bg-black/40" />}
            <span className="relative flex items-center gap-1">
              {i + 1}
              {s.imageFile && <ImageIcon className="h-3 w-3 opacity-70" />}
              {s.isEndFrame && <Flag className="h-3 w-3 opacity-70" />}
            </span>
            {i < segments.length - 1 && (
              <span
                onPointerDown={(e) => startDrag(e, 'shots', i, 'resize-end', { start: starts[i], length: s.length })}
                className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize bg-white/0 hover:bg-white/40"
                title="Drag to change how long this shot lasts"
              />
            )}
          </div>
        ))}
        {busy && (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-white/50">
            uploading…
          </span>
        )}
      </div>

      {refsOn && clipTrack('motion', motion, setMotion, 'bg-sky-500/30 text-sky-200', Film)}
      {refsOn && clipTrack('audio', audio, setAudio, 'bg-emerald-500/30 text-emerald-200', Music)}
    </div>
  );
};
