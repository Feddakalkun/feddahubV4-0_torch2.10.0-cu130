import { useMemo, useRef, useState } from 'react';
import { Clapperboard, Copy, Film, Plus, Trash2 } from 'lucide-react';
import { WorkflowPage } from './WorkflowPage';
import { DirectorTimeline, type Clip, type Segment } from '../components/workflows/DirectorTimeline';
import { BACKEND_API } from '../config/api';

/**
 * MiniMax H3 Director - a storyboard, not a prompt box.
 *
 * The node takes one JSON string, `timeline_data`, holding the whole editor
 * state, plus `local_prompts` and `segment_lengths` as flattened views of the
 * same shots. All three are built here from one source of truth, because
 * letting them drift is how a render silently uses last week's shot list.
 *
 * That shape is v3's and it was right. What is not carried over is v3's way of
 * getting there: a second page of eleven hundred lines with its own submit, its
 * own missing-model banner and its own output pane. Here the storyboard is
 * handed to WorkflowPage through extraTop / extraParams / hideKeys, so there is
 * still one renderer, one place a run starts, and one banner saying which
 * models are missing.
 *
 * The overall prompt goes into timeline_data rather than being sent as a param:
 * the node declares `global_prompt` as force_input and reads it out of the
 * timeline, so a param would go nowhere.
 */

const FPS = 24;
const MIN_FRAMES = 5;

/** Frames from seconds, never shorter than the node will accept. */
const secs = (n: number) => Math.max(MIN_FRAMES, Math.round(n * FPS));

const newSegment = (prompt = ''): Segment => ({
  id: `s${Math.random().toString(36).slice(2, 9)}`,
  prompt,
  length: secs(1.5),
  type: 'text',
});

interface Props {
  workflowId: string;
}

export const MiniMaxDirectorPage = ({ workflowId }: Props) => {
  const [globalPrompt, setGlobalPrompt] = useState(
    'Cinematic, golden hour, anamorphic lens, shallow depth of field, fine film grain.',
  );
  const [segments, setSegments] = useState<Segment[]>([
    newSegment('wide establishing shot'),
    newSegment('cut to a closer angle'),
  ]);
  const [motion, setMotion] = useState<Clip[]>([]);
  const [audio, setAudio] = useState<Clip[]>([]);
  const [selected, setSelected] = useState(0);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const totalFrames = useMemo(
    () => segments.reduce((n, s) => n + Math.max(1, s.length), 0),
    [segments],
  );

  /**
   * A dropped file has to reach ComfyUI's input folder before the timeline can
   * show it. The backend answers with the name ComfyUI gave it, which is not
   * always the name that was sent - it renames on collision.
   */
  const upload = async (file: File): Promise<string | null> => {
    const body = new FormData();
    body.append('file', file);
    try {
      const r = await fetch(`${BACKEND_API.BASE_URL}/api/upload`, { method: 'POST', body });
      if (!r.ok) return null;
      const d = await r.json();
      return String(d.filename ?? d.name ?? '') || null;
    } catch {
      return null;
    }
  };

  const patch = (i: number, next: Partial<Segment>) =>
    setSegments((s) => s.map((seg, j) => (j === i ? { ...seg, ...next } : seg)));

  const shot = segments[Math.min(selected, segments.length - 1)];

  return (
    <WorkflowPage
      workflowId={workflowId}
      // The storyboard drives these three. Drawing them as text boxes as well
      // would be two editors for one value, and the loser would be whichever
      // was touched first. Width and height are not among them - they are not
      // the storyboard's business, and hiding them only took the resolution
      // away.
      hideKeys={['prompt', 'segment_lengths', 'timeline']}
      extraParams={() => ({
        timeline_data: JSON.stringify({
          mainTrackEnabled: true,
          audioTrackEnabled: audio.length > 0,
          motionTrackEnabled: motion.length > 0,
          global_prompt: globalPrompt,
          prompt_format: 'minimax',
          reference_mode: motion.length || audio.length ? 'ON' : 'OFF',
          normalStartFrame: 0,
          normalDurationFrames: totalFrames,
          segments: segments.map((s) => ({
            id: s.id,
            prompt: s.prompt,
            length: Math.max(1, s.length),
            ...(s.imageFile ? { imageFile: s.imageFile } : {}),
          })),
          motionSegments: motion.map((c) => ({ file: c.file, start: c.start, length: c.length })),
          audioSegments: audio.map((c) => ({ file: c.file, start: c.start, length: c.length })),
          characters: [],
        }),
        local_prompts: segments.map((s) => s.prompt.trim()).join(' | '),
        segment_lengths: segments.map((s) => Math.max(1, s.length)).join(','),
        start_frame: 0,
        end_frame: totalFrames,
        duration_frames: totalFrames,
        start_second: 0,
        end_second: totalFrames / FPS,
        duration_seconds: totalFrames / FPS,
        frame_rate: FPS,
        use_custom_audio: audio.length > 0,
        use_custom_motion: motion.length > 0,
      })}
      extraTop={
        <div className="space-y-3">
          <div className="cockpit-panel">
            <div className="cockpit-panel-head">
              <span>Overall prompt</span>
              <span>everything true of the whole clip</span>
            </div>
            <textarea
              value={globalPrompt}
              onChange={(e) => setGlobalPrompt(e.target.value)}
              rows={3}
              className="fedda-input w-full rounded-lg px-3 py-2 text-sm text-white/90 resize-y"
              placeholder="Style, setting, who is in it - what does not change between shots."
            />
          </div>

          <div className="cockpit-panel">
            <div className="cockpit-panel-head">
              <span className="inline-flex items-center gap-1.5">
                <Clapperboard className="h-3.5 w-3.5" /> Storyboard
              </span>
              <span>
                {segments.length} shots · {(totalFrames / FPS).toFixed(1)}s
              </span>
            </div>

            <DirectorTimeline
              segments={segments}
              setSegments={setSegments}
              motion={motion}
              setMotion={setMotion}
              audio={audio}
              setAudio={setAudio}
              fps={FPS}
              selected={selected}
              setSelected={setSelected}
              onUpload={upload}
              refsOn
            />

            <p className="mt-2 text-[10px] leading-snug text-white/35">
              Drag a shot to reorder it, drag its right edge to change how long it lasts - the
              clip stays the same length, so what one shot gains the next gives up. Drop an image
              on a shot to start it from that frame; drop a video or a sound file on the lower
              tracks to copy motion or match audio.
            </p>

            {shot && (
              <div className="mt-3 rounded-lg border border-white/8 bg-white/[0.02] p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/40">
                    Shot {selected + 1}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      title="Duplicate this shot"
                      onClick={() =>
                        setSegments((s) => [
                          ...s.slice(0, selected + 1),
                          { ...s[selected], id: `s${Math.random().toString(36).slice(2, 9)}` },
                          ...s.slice(selected + 1),
                        ])
                      }
                      className="rounded border border-white/10 p-1 text-white/40 hover:text-white/80"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      title="Remove this shot"
                      disabled={segments.length <= 1}
                      onClick={() => {
                        setSegments((s) => s.filter((_, j) => j !== selected));
                        setSelected((i) => Math.max(0, i - 1));
                      }}
                      className="rounded border border-white/10 p-1 text-white/40 hover:text-white/80 disabled:opacity-30"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                <textarea
                  value={shot.prompt}
                  onChange={(e) => patch(selected, { prompt: e.target.value })}
                  rows={2}
                  className="fedda-input w-full rounded-lg px-3 py-2 text-sm text-white/90 resize-y"
                  placeholder="What happens in this shot only."
                />

                <div className="mt-2 flex items-center gap-3">
                  <span className="text-[10px] uppercase tracking-[0.12em] text-white/35">
                    Seconds
                  </span>
                  <input
                    type="number"
                    min={MIN_FRAMES / FPS}
                    step={0.5}
                    value={(shot.length / FPS).toFixed(1)}
                    onChange={(e) => patch(selected, { length: secs(Number(e.target.value)) })}
                    className="fedda-input w-24"
                  />
                  {shot.imageFile && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-white/40">
                      <Film className="h-3 w-3" />
                      {shot.imageFile}
                      <button
                        type="button"
                        onClick={() => patch(selected, { imageFile: undefined, type: 'text' })}
                        className="ml-1 text-white/30 hover:text-white/70"
                      >
                        remove
                      </button>
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setSegments((s) => [...s, newSegment()]);
                  setSelected(segments.length);
                }}
                className="fedda-btn-ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
              >
                <Plus className="h-3.5 w-3.5" /> Add shot
              </button>
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="fedda-btn-ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
              >
                <Film className="h-3.5 w-3.5" /> Image for this shot
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  const name = await upload(f);
                  if (name) patch(selected, { imageFile: name, fileName: name, type: 'image' });
                }}
              />
            </div>
          </div>
        </div>
      }
    />
  );
};
