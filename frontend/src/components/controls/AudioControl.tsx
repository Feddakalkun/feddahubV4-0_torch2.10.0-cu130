import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, Pause, Play, RotateCcw, Upload } from 'lucide-react';
import type { AudioValue, WorkflowField } from '../../types/workflow';
import { BACKEND_API } from '../../config/api';

/**
 * Pick a sound file, hear it, and choose the piece of it to use.
 *
 * The trim is not decoration. Pixaroma's audio node takes `start` and `length`
 * in seconds inside its hidden state, so a five-second clip out of a
 * three-minute song is something the graph can already do - there was simply no
 * way to say it. Uploading the whole file and rendering from the top is not the
 * same feature.
 *
 * Playback is local. The file plays from the browser's own blob rather than
 * from the uploaded copy: same bytes, no round trip, and no dependence on
 * ComfyUI being reachable to hear what you just chose.
 */

interface Props {
  field: WorkflowField;
  value: AudioValue | null;
  onChange: (next: AudioValue | null) => void;
  disabled?: boolean;
}

const clock = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

export const AudioControl = ({ field, value, onChange, disabled }: Props) => {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = value?.start ?? 0;
  // `end` is what a person picks; `length` is what the node wants. Kept as end
  // here and converted on the way out, because dragging a handle to 0:12 and
  // seeing 7.4 is not the same thing.
  const end = value?.end ?? duration;

  useEffect(() => () => { if (localUrl) URL.revokeObjectURL(localUrl); }, [localUrl]);

  // Stop at the trim point rather than playing on to the end of the file -
  // otherwise the preview is not what the run will use.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const tick = () => {
      setPlayhead(el.currentTime);
      if (end > start && el.currentTime >= end) {
        el.pause();
        el.currentTime = start;
        setPlaying(false);
      }
    };
    el.addEventListener('timeupdate', tick);
    return () => el.removeEventListener('timeupdate', tick);
  }, [start, end]);

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    setLocalUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(file); });
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch(`${BACKEND_API.BASE_URL}/api/upload`, { method: 'POST', body });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.detail || `Upload failed (${response.status})`);
      }
      // A fresh file resets the trim: the old points mean nothing in a new song.
      onChange({ file: data.filename, start: 0, end: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
      return;
    }
    if (el.currentTime < start || el.currentTime >= end) el.currentTime = start;
    void el.play();
    setPlaying(true);
  };

  const setRange = (nextStart: number, nextEnd: number) => {
    if (!value) return;
    onChange({ ...value, start: Math.max(0, nextStart), end: Math.max(0, nextEnd) });
  };

  const busy = disabled || uploading;
  const span = end > start ? end - start : 0;

  return (
    <div className="cockpit-panel">
      <div className="cockpit-panel-head">
        <span>{field.label}</span>
        <span>{value?.file ? `${clock(span)} of ${clock(duration)}` : 'required'}</span>
      </div>

      <div className="cockpit-upload-row">
        <button
          type="button"
          disabled={busy}
          className="fedda-btn-ghost inline-flex items-center gap-2 px-3 py-2 text-xs"
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          {uploading ? 'Uploading' : value?.file ? 'Replace' : 'Choose sound'}
        </button>
        <span className="text-[11px] text-white/45 truncate">
          {value?.file || 'Nothing chosen - or drop one here'}
        </span>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept="audio/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = '';
          }}
        />
      </div>

      {localUrl && (
        <>
          <audio
            ref={audioRef}
            src={localUrl}
            preload="metadata"
            onLoadedMetadata={(e) => {
              const secs = e.currentTarget.duration;
              setDuration(secs);
              // An untrimmed file means the whole thing; fill the end in so the
              // handle has somewhere to start from.
              if (value && !value.end) onChange({ ...value, start: 0, end: secs });
            }}
            onEnded={() => setPlaying(false)}
          />

          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={toggle}
              disabled={busy}
              className="fedda-btn-ghost inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs"
              title={playing ? 'Pause' : 'Play the trimmed part'}
            >
              {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {playing ? 'Pause' : 'Play'}
            </button>
            <button
              type="button"
              onClick={() => setRange(0, duration)}
              disabled={busy || !value}
              className="fedda-btn-ghost inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs"
              title="Use the whole file"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Whole
            </button>
            <span className="ml-auto font-mono text-[11px] text-white/45">
              {clock(playhead)}
            </span>
          </div>

          {/* Two sliders over one track rather than a drawn waveform: a waveform
              needs the samples decoded, and this answers the same question. */}
          <div className="mt-2 grid gap-1">
            <label className="grid grid-cols-[38px_minmax(0,1fr)_44px] items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-white/35">From</span>
              <input
                type="range"
                className="cockpit-range"
                min={0}
                max={Math.max(duration, 0.1)}
                step={0.1}
                value={start}
                disabled={busy}
                onChange={(e) => setRange(Number(e.target.value), Math.max(end, Number(e.target.value) + 0.1))}
              />
              <span className="text-right font-mono text-[11px] text-white/55">{clock(start)}</span>
            </label>
            <label className="grid grid-cols-[38px_minmax(0,1fr)_44px] items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-white/35">To</span>
              <input
                type="range"
                className="cockpit-range"
                min={0}
                max={Math.max(duration, 0.1)}
                step={0.1}
                value={end}
                disabled={busy}
                onChange={(e) => setRange(Math.min(start, Number(e.target.value) - 0.1), Number(e.target.value))}
              />
              <span className="text-right font-mono text-[11px] text-white/55">{clock(end)}</span>
            </label>
          </div>
        </>
      )}

      {error && (
        <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-amber-300">
          <AlertCircle className="h-3 w-3 shrink-0" /> {error}
        </p>
      )}
    </div>
  );
};
