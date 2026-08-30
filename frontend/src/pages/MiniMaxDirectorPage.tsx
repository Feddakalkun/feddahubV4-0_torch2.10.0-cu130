import { useMemo, useRef, useState } from 'react';
import {
  Plus, Trash2, Copy, Wand2,
  Image as ImageIcon, Film, Music, X,
} from 'lucide-react';
import { WorkflowPage } from './WorkflowPage';
import { InfoTip } from '../components/ui/InfoTip';
import { useToast } from '../components/ui/Toast';
import { BACKEND_API } from '../config/api';
import { usePersistentState } from '../hooks/usePersistentState';
import { DirectorTimeline } from '../components/workflows/DirectorTimeline';

/**
 * MiniMax H3 Director - a storyboard, not a prompt box.
 *
 * The node takes one JSON string, `timeline_data`, holding the whole editor
 * state, plus `local_prompts` and `segment_lengths` as flattened views of the
 * same shots. All three are built here from one source of truth, because
 * letting them drift is how a render silently uses last week's shot list.
 *
 * The prompt box above is the global prompt: style, scene, who is in it. It is
 * written into timeline_data rather than sent as a param - the node declares
 * `global_prompt` as force_input and reads the value out of the timeline
 * instead, so a param would go nowhere.
 */

// --- what the node accepts, from minimax_core.py ---------------------------
const MAX_REF_VIDEOS = 3;
const MAX_REF_AUDIOS = 3;
const MAX_REF_FILES = 12;
const REF_VIDEO_TOTAL_SEC = 15;
const TRAINED_MIN_FRAMES = 96;
const TRAINED_MAX_FRAMES = 360;

/**
 * The clip lengths H3 renders, on its 17k+5 grid.
 *
 * 360 frames is not a ceiling. The node is explicit that nothing caps the
 * length and longer windows do render - what ends at the model card's 4-15s is
 * the quality, and the clock: attention is quadratic in sequence length, so
 * twice the frames is roughly four times the wait, and drift or looping starts
 * to show. Cutting the list there would have hidden a choice rather than
 * explained it, so the longer ones are offered and labelled.
 */
const LONGEST_OFFERED = 702;   // 29.25s - past this the wait stops being worth it

const clipLengths = (from: number, to: number): number[] => {
  const out: number[] = [];
  for (let n = 5; n <= to; n += 17) if (n >= from) out.push(n);
  return out;
};

const CLIP_LENGTHS = clipLengths(TRAINED_MIN_FRAMES, TRAINED_MAX_FRAMES);
const LONG_CLIP_LENGTHS = clipLengths(TRAINED_MAX_FRAMES + 1, LONGEST_OFFERED);

/**
 * Share `total` frames across `count` shots, keeping each at least MIN_SHOT and
 * making the parts add up exactly. The remainder goes to the earlier shots one
 * frame at a time, which is invisible on screen and keeps the sum honest -
 * rounding each share independently loses or gains frames and the clip stops
 * being a legal length.
 */
const MIN_SHOT = 8;
const share = (total: number, count: number): number[] => {
  const base = Math.max(MIN_SHOT, Math.floor(total / count));
  const out = Array.from({ length: count }, () => base);
  let left = total - base * count;
  for (let i = 0; left > 0; i = (i + 1) % count) { out[i] += 1; left -= 1; }
  for (let i = count - 1; left < 0 && i >= 0; i -= 1) {
    const take = Math.min(-left, out[i] - MIN_SHOT);
    out[i] -= take; left += take;
  }
  return out;
};

type Segment = {
  id: string;
  prompt: string;
  length: number;
  type: 'text' | 'image';
  imageFile?: string;
  fileName?: string;
  isEndFrame?: boolean;
};

type Clip = { id: string; file: string; start: number; length: number };

type Subject = {
  shortName: string;
  description: string;
  kind: 'person' | 'animal' | 'object' | 'place';
  retention: 'fully_preserved' | 'loosely_referenced';
  images: string[];
};

const SUBJECT_KINDS = ['person', 'animal', 'object', 'place'] as const;

const newId = () => `seg${Math.random().toString(36).slice(2, 9)}`;

const emptySubject = (): Subject => ({
  shortName: '', description: '', kind: 'person',
  retention: 'fully_preserved', images: [],
});

/**
 * Two shots of 62 frames is 124 - over the 96 H3 was trained on, and exactly on
 * the 17k+5 grid so nothing is rounded up. The page used to open on 82, which
 * tripped its own "below what H3 was trained on" notice before anyone touched
 * anything.
 */
/** Shots from a preset, laid end to end at the length H3 renders cleanly. */
const DEFAULT_CLIP = 124;   // 5.17s, the shortest comfortable length on the grid

const shotsOf = (p: Preset, total = DEFAULT_CLIP): Segment[] => {
  const parts = share(total, p.shots.length);
  return p.shots.map((prompt, i) => ({
    id: `seg${i}`, type: 'text' as const, length: parts[i], prompt,
  }));
};

/** The shapes H3 is actually run at, as one question instead of two sliders. */
const SHAPES = {
  landscape: { width: 1344, height: 768 },
  portrait: { width: 768, height: 1344 },
  square: { width: 1024, height: 1024 },
} as const;

// Parked until the walkthrough covers the whole UI rather than this one page.
export const TOUR_STEPS_PARKED: unknown[] = [
  {
    title: 'MiniMax Director',
    body: 'Want to direct? Most video tools give you one prompt and one shot. This one gives you a '
      + 'shot list: you set the scene once, then say what happens in each shot, and it comes back '
      + 'as one clip with sound already on it. There is a storyboard loaded right now - press '
      + 'Render storyboard and watch what it does. Six of them are up there to pick from.',
  },
  {
    target: 'workflow-prompt',
    title: 'Describe the scene',
    body: 'This is the part that never changes: the look, the place, who is in it. Everything that '
      + 'is still true in the last frame. Leave the action out - camera moves and things happening '
      + 'belong to the shots. If you already have a picture in mind, drop it here and it writes '
      + 'this for you.',
    placement: 'left',
  },
  {
    target: 'director-timeline',
    title: 'Build the scene, shot by shot',
    body: 'Each block is a shot, and its width is how long it lasts - drag the right edge to '
      + 'stretch it, drag the block to move it earlier or later. Underneath, each shot gets a card '
      + 'where you say what happens: the framing, the movement, the sound. Drop a photo on a card '
      + 'and it fills the card in for you, reading the shot before it first so the result is a cut '
      + 'and not a fresh start. Anything you typed yourself is left alone.',
    placement: 'bottom',
  },
  {
    target: 'director-refs',
    title: 'References: for when a face has to stay the same',
    body: 'Off, you already get pictures on shots - a first frame, a last frame, and a scene. On, '
      + 'you also get character slots, reference video and reference audio, which is what you want '
      + 'when the same person has to survive every cut. It is a different checkpoint, so the first '
      + 'render after switching spends a minute reading it off disk. After that it costs nothing.',
    placement: 'top',
  },
  {
    title: 'That is the whole thing',
    body: 'Scene at the top, shots underneath, Render at the bottom. Lengths are handled for you - '
      + 'the page only offers ones the model can actually make. Pick a storyboard, change one line, '
      + 'run it again: that is the loop, and it is the fastest way to find out what this model is '
      + 'good at.',
  },
];

/**
 * Starting points. Three shots each, 41 frames apiece - 123, which the model
 * rounds to 124, so none of them opens on a warning.
 *
 * They are deliberately different in kind, not just in subject: something fast,
 * something at night, something still, a face, an effort, and a place with
 * nobody in it. The examples are the only documentation most people read, so
 * each shot names a framing, a movement and a sound.
 */
type Preset = {
  name: string;
  prompt: string;
  soundscape: string;
  shots: string[];
  /** Written for this canvas. Anything unset means landscape. */
  shape?: 'landscape' | 'portrait' | 'square';
  /** Score the characters cannot hear. Only worth setting when it is the point. */
  music?: string;
};

const PRESETS: Preset[] = [
  {
    name: 'Bunny',
    prompt: 'Live-action, cinematic. A young woman who is half human and half rabbit - '
      + 'two long grey-brown ears rising from dark hair, their inner shells warm and '
      + 'translucent, fine fur along her jaw and forearms, amber eyes with round pupils. '
      + 'A greenhouse at first light, humid air, 50mm, shallow depth of field, muted moss '
      + 'and rust.',
    soundscape: 'rain on glass overhead, a watering can set down, one blackbird outside',
    music: 'a slow piano figure, sparse, low in the mix',
    shots: [
      'medium shot: she moves along a bench of seedlings, touching each tray, her ears '
        + 'turning independently toward the rain on the glass above her',
      'cut to a close-up of her hands lifting a seedling into the light, fur soft along her '
        + 'wrists, before she looks up and says: "This one made it."',
      'cut to a wide shot from the far end of the greenhouse, she stands still in the middle '
        + 'of the frame as the rain eases and light comes through the glass behind her',
    ],
  },
  {
    name: 'Desert',
    prompt: 'Cinematic desert chase, late afternoon golden hour, anamorphic lens, '
      + 'shallow depth of field, fine film grain.',
    soundscape: 'wind over open sand, a distant engine',
    shots: [
      'wide establishing shot: the rider crests the dune, engine roaring, sand spraying off '
        + 'the rear wheel into the low sun',
      'cut to a low tracking shot alongside the bike, heat haze rippling, the horizon tilting '
        + 'as she leans into the turn',
      'cut to a close-up on her visor, the dunes reflected in it, she exhales and the engine '
        + 'note drops away',
    ],
  },
  {
    name: 'Rain city',
    prompt: 'Night street after rain, neon signs bleeding into the wet asphalt, handheld, '
      + '35mm, heavy shadow, cyan and magenta.',
    soundscape: 'steady rain, tyres through standing water, a shop sign buzzing',
    shots: [
      'wide shot down the empty street, rain falling through a streetlight, a bus hisses past '
        + 'left to right and its reflection breaks apart in a puddle',
      'cut to a mid shot of a man under an awning, collar up, watching the road, the sign above '
        + 'him flickering across his face',
      'cut to a close-up of his hand letting a cigarette go, it hits the water and dies, the '
        + 'rain gets louder',
    ],
  },
  {
    name: 'Kitchen',
    prompt: 'A small kitchen early in the morning, low sun through a window, warm and slightly '
      + 'overexposed, soft grain, everything still.',
    soundscape: 'a kettle building, a clock, birds outside the glass',
    shots: [
      'wide shot of the kitchen, dust turning in the light from the window, nothing moving but '
        + 'steam beginning to rise from the kettle',
      'cut to a close-up of a hand pouring, the water darkening in the cup, steam climbing '
        + 'through the sunlight',
      'cut to a woman at the table with the cup, she looks up toward the window and the room '
        + 'goes quiet as the kettle stops',
    ],
  },
  {
    name: 'First snow',
    prompt: 'A forest under the first snow of the year, overcast, desaturated, cold blue light, '
      + 'long lens, everything soft at the edges.',
    soundscape: 'snow falling on branches, a crow far off, nothing else',
    shots: [
      'wide shot between the trunks, snow drifting down without wind, the ground already white '
        + 'and the trees still dark',
      'cut to a slow push in on a branch, snow building on it until it gives and the whole '
        + 'branch drops its load',
      'cut to a low shot along the ground, a deer steps into frame, stops, and its breath shows '
        + 'in the cold',
    ],
  },
  {
    name: 'Gym',
    prompt: 'A boxing gym in the late afternoon, hard overhead light, dust in the air, high '
      + 'contrast, sweat catching the light, handheld.',
    soundscape: 'a heavy bag under repeated impact, ragged breathing, a distant skipping rope',
    shots: [
      'wide shot of the gym floor, one figure working the bag, everyone else out of focus '
        + 'behind, the bag swinging back into every hit',
      'cut to a tight shot on the hands, wraps soaked through, the impact travelling up the '
        + 'forearm on each strike',
      'cut to a close-up on the face, eyes down, breathing hard, the sound of the room dropping '
        + 'away until only the breath is left',
    ],
  },
  {
    name: 'Dance',
    shape: 'portrait',
    prompt: 'Vertical phone video, a young woman dancing in a bright bedroom, afternoon sun '
      + 'through a window, fairy lights along the wall, slightly overexposed, shot on a phone '
      + 'held at chest height.',
    soundscape: 'a room with soft furnishings, feet on a rug, fabric moving, a laugh',
    music: 'upbeat electronic pop, four-on-the-floor kick around 120 BPM, bright synth stabs '
      + 'on the offbeat, the low end dropping out for a bar and coming back',
    shots: [
      'medium shot framed head to knee, she starts on the beat with a sharp shoulder roll, '
        + 'hair swinging across her face, the phone bobbing slightly with the rhythm',
      'she steps toward the camera into a close waist-up framing, arms crossing fast in front '
        + 'of her, grinning straight down the lens',
      'she spins away and back, the fairy lights streaking behind her, and lands facing the '
        + 'camera as the music cuts',
    ],
  },
  {
    name: 'News desk',
    prompt: 'A television news studio, a presenter behind a desk, cool even key light, a large '
      + 'screen behind her showing a muted city skyline, shallow depth of field, broadcast look.',
    soundscape: 'a quiet studio, air conditioning, faint paper',
    shots: [
      'medium shot, she looks straight down the lens and says, "Good evening. Tonight, the '
        + 'story everyone in this city is talking about." She sets her papers down as she '
        + 'finishes and the camera pushes in slowly',
    ],
  },
  {
    name: 'Rooftop',
    prompt: 'A rooftop at dusk over a large city, sky going from orange to deep blue, wide lens, '
      + 'clean and cold, no people.',
    soundscape: 'wind across the roof, traffic far below, an aircraft passing over',
    shots: [
      'wide shot across the rooftops, the last light on the far towers, wind moving a loose '
        + 'sheet of plastic in the foreground',
      'cut to a slow pan along the parapet, the city lights coming on in sequence below as the '
        + 'sky darkens behind them',
      'cut to a locked-off shot of the horizon, an aircraft crossing left to right, its lights '
        + 'blinking, the wind rising over everything',
    ],
  },
];

const fmt = (frames: number, fps: number) => `${(frames / fps).toFixed(2)}s`;

interface Props {
  /** Set by App: the full-weight Director and the GGUF twin share this page. */
  workflowId: string;
}

export const MiniMaxDirectorPage = ({ workflowId }: Props) => {
  const { toast } = useToast();

  const [segments, setSegments] = usePersistentState<Segment[]>(
    'mmx_director_segments_v2', shotsOf(PRESETS[0]));
  const [selected, setSelected] = useState(0);
  const [motion, setMotion] = usePersistentState<Clip[]>('mmx_director_motion', []);
  const [audio, setAudio] = usePersistentState<Clip[]>('mmx_director_audio', []);
  const [subjects, setSubjects] = usePersistentState<Subject[]>(
    'mmx_director_subjects', [emptySubject()]);
  const [fps, setFps] = usePersistentState('mmx_director_fps', 24);
  const [refsOn, setRefsOn] = usePersistentState('mmx_director_refs', false);
  const [soundscape, setSoundscape] = usePersistentState('mmx_director_soundscape_v2', PRESETS[0].soundscape);
  const [music, setMusic] = usePersistentState('mmx_director_music', '');
  // v3's host owned these two as form fields. v4's host owns the schema's
  // fields, and neither of these is one: the scene prompt is written into
  // timeline_data because the node reads global_prompt from there, and shape
  // is two node inputs - custom_width and custom_height - behind one question.
  const [scenePrompt, setScenePrompt] = usePersistentState(
    'mmx_director_scene', PRESETS[0].prompt);
  const [canvasShape, setCanvasShape] = usePersistentState<keyof typeof SHAPES>(
    'mmx_director_shape', 'landscape');
  const [showChars, setShowChars] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [captioning, setCaptioning] = useState<number | null>(null);
  const [preset, setPreset] = usePersistentState('mmx_director_preset', 0);
  // Bumped when a preset is loaded, and used as WorkflowPage's key. The global
  // prompt lives in that component's persisted state, so the only way to
  // replace it without keeping a second copy here is to write the stored value
  // and let it mount again.
  const [presetNonce, setPresetNonce] = useState(0);
  const [clip, setClip] = usePersistentState('mmx_director_clip', DEFAULT_CLIP);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const pending = useRef<((filename: string) => void) | null>(null);

  const totalFrames = useMemo(
    () => segments.reduce((n, s) => n + Math.max(1, s.length), 0), [segments]);

  /** Uploads and returns the name ComfyUI knows the file by, or null. */
  const uploadFile = async (file: File): Promise<string | null> => {
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${BACKEND_API.BASE_URL}/api/upload`, { method: 'POST', body: form });
      const data = await res.json();
      if (!data.success) throw new Error(data.detail || 'Upload failed');
      return data.filename as string;
    } catch (err: any) {
      toast(err.message || 'Upload failed', 'error');
      return null;
    }
  };

  const upload = async (file: File, then: (filename: string) => void) => {
    const name = await uploadFile(file);
    if (name) then(name);
  };

  /**
   * Attach a picture to a shot and write that shot from it.
   *
   * The previous shot's text goes with the request. Without it the model
   * describes the picture on its own terms and every shot comes back as an
   * establishing shot; with it, the answer is the cut that follows.
   */
  const captionInto = async (i: number, file: File, force = false) => {
    const name = await uploadFile(file);
    if (!name) return;
    patch(i, { imageFile: name, fileName: name, type: 'image' });
    setSelected(i);
    // A drop never overwrites what somebody wrote; the button is somebody
    // asking, so it does.
    if (!force && segments[i]?.prompt.trim()) return;

    setCaptioning(i);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('context', 'minimax-h3');
      form.append('previous', segments[i - 1]?.prompt ?? '');
      const res = await fetch(`${BACKEND_API.BASE_URL}/api/ollama/caption`, {
        method: 'POST', body: form,
      });
      const data = await res.json();
      if (data?.success && data.caption) patch(i, { prompt: data.caption });
      else if (data?.detail) toast(String(data.detail), 'error');
    } catch (err: any) {
      toast(err.message || 'Could not write the shot from that picture', 'error');
    } finally {
      setCaptioning(null);
    }
  };

  /**
   * Write a shot from the picture already on it. The file lives in ComfyUI's
   * input folder, so it is fetched back rather than asked for again - the
   * captioner wants bytes, and this is the same bytes it saw.
   */
  const describeAgain = async (i: number, target: 'shot' | 'scene' = 'shot') => {
    const file = segments[i]?.imageFile;
    if (!file) return;
    setCaptioning(i);
    try {
      const img = await fetch(
        `/comfy/view?filename=${encodeURIComponent(file)}&subfolder=&type=input`);
      const blob = await img.blob();
      const form = new FormData();
      form.append('file', new File([blob], file, { type: blob.type || 'image/png' }));
      form.append('context', target === 'scene' ? 'minimax-h3-director' : 'minimax-h3');
      if (target === 'shot') form.append('previous', segments[i - 1]?.prompt ?? '');
      const res = await fetch(`${BACKEND_API.BASE_URL}/api/ollama/caption`,
                              { method: 'POST', body: form });
      const data = await res.json();
      if (!data?.success || !data.caption) {
        toast(String(data?.detail || 'Nothing came back'), 'error');
        return;
      }
      if (target === 'shot') {
        patch(i, { prompt: data.caption });
      } else {
        // The scene box belongs to WorkflowPage, so it is written the same way
        // a preset writes it: to the stored value, then mount again.
        try {
          window.localStorage.setItem(
            'wf_minimax-h3-director-v2_prompt', JSON.stringify(data.caption));
          setPresetNonce((v) => v + 1);
        } catch { /* leave the old scene rather than lose it */ }
      }
    } catch (err: any) {
      toast(err.message || 'Could not read that picture', 'error');
    } finally {
      setCaptioning(null);
    }
  };

  const pickFile = (accept: string, then: (filename: string) => void) => {
    if (!fileInput.current) return;
    pending.current = then;
    fileInput.current.accept = accept;
    fileInput.current.value = '';
    fileInput.current.click();
  };

  /** Replace the whole storyboard with one of the starting points. */
  const loadPreset = (n: number) => {
    const p = PRESETS[n];
    if (!p) return;
    setPreset(n);
    setSegments(() => shotsOf(p, clip));
    setSoundscape(p.soundscape);
    setMusic(p.music ?? '');
    setSelected(0);
    try {
      const K = 'wf_minimax-h3-director-v2_';
      window.localStorage.setItem(K + 'prompt', JSON.stringify(p.prompt));
      // The shape lives in WorkflowPage's settings, so it is merged rather than
      // replaced - the rest of that record is steps, seed and the like, and a
      // preset has no business resetting those. Unset means landscape, so
      // leaving a vertical preset for a horizontal one puts the canvas back.
      const cur = JSON.parse(window.localStorage.getItem(K + 'settings') || '{}');
      window.localStorage.setItem(
        K + 'settings', JSON.stringify({ ...cur, shape: p.shape ?? 'landscape' }));
    } catch { /* a full or blocked store just leaves the old prompt */ }
    setPresetNonce((v) => v + 1);
  };

  const patch = (i: number, p: Partial<Segment>) =>
    setSegments((s) => s.map((seg, j) => (j === i ? { ...seg, ...p } : seg)));

  /** Re-divide the clip so the parts still add up to a length H3 can render. */
  const redistribute = (segs: Segment[], total: number): Segment[] => {
    const parts = share(total, segs.length);
    return segs.map((s, i) => ({ ...s, length: parts[i] }));
  };

  const setClipLength = (total: number) => {
    setClip(total);
    setSegments((s) => redistribute(s, total));
  };

  const addShot = () => {
    setSegments((s) => redistribute(
      [...s, { id: newId(), prompt: '', length: MIN_SHOT, type: 'text' }], clip));
    setSelected(segments.length);
  };

  const removeShot = (i: number) => {
    if (segments.length <= 1) { toast('A storyboard needs at least one shot', 'error'); return; }
    setSegments((s) => redistribute(s.filter((_, j) => j !== i), clip));
    setSelected((k) => Math.max(0, Math.min(k, segments.length - 2)));
  };

  const duplicateShot = (i: number) => {
    setSegments((s) => redistribute(
      [...s.slice(0, i + 1), { ...s[i], id: newId() }, ...s.slice(i + 1)], clip));
    setSelected(i + 1);
  };

  // Reference files the node will actually be handed, against its own caps.
  const refImages = segments.filter((s) => s.imageFile).length
    + subjects.reduce((n, s) => n + s.images.length, 0);
  const refFiles = refImages + motion.length + audio.length;
  const motionSeconds = motion.reduce((n, c) => n + c.length, 0) / fps;

  /** The whole editor as the node wants it. One place, so nothing can drift. */
  const buildTimeline = (globalPrompt: string) => {
    let cursor = 0;
    const laidOut = segments.map((s) => {
      const seg = {
        id: s.id,
        start: cursor,
        length: Math.max(1, s.length),
        prompt: s.prompt,
        type: s.imageFile ? 'image' : 'text',
        isEndFrame: !!s.isEndFrame,
        ...(s.imageFile ? { imageFile: s.imageFile, fileName: s.fileName || s.imageFile } : {}),
      };
      cursor += seg.length;
      return seg;
    });
    return {
      mainTrackEnabled: true,
      audioTrackEnabled: audio.length > 0,
      motionTrackEnabled: motion.length > 0,
      showFilenames: true,
      showPromptZones: true,
      overrideAudio: false,
      inpaint_audio: true,
      global_prompt: globalPrompt,
      retake_global_prompt: '',
      overall_soundscape: soundscape,
      non_diegetic_music: music,
      prompt_override: '',
      prompt_override_on: false,
      retakeMode: false,
      retakeStart: 0,
      retakeLength: 0,
      retakePrompt: '',
      retakeStrength: 1,
      retakeVideo: null,
      normalStartFrame: 0,
      normalDurationFrames: totalFrames,
      reference_mode: refsOn ? 'ON' : 'OFF',
      prompt_format: 'minimax',
      analyzeProvider: 'ollama',
      analyzeBaseUrl: '',
      analyzeModel: '',
      summary: '',
      task_type_override: '',
      subjectSlotCount: subjects.length,
      subjects: subjects.map((s) => ({
        images: s.images,
        description: s.description,
        shortName: s.shortName,
        kind: s.kind,
        retention: s.retention,
        retentionNote: '',
      })),
      segments: laidOut,
      motionSegments: motion.map((c) => ({
        id: c.id, start: c.start, length: c.length, videoFile: c.file, fileName: c.file,
      })),
      audioSegments: audio.map((c) => ({
        id: c.id, start: c.start, length: c.length, audioFile: c.file, fileName: c.file,
      })),
    };
  };

  return (
    <>
      <input
        ref={fileInput} type="file" className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          const then = pending.current;
          pending.current = null;
          if (f && then) void upload(f, then);
        }}
      />
      <WorkflowPage
        key={presetNonce}
        workflowId={workflowId}
        // The storyboard drives these; drawing them as boxes too would be two
        // editors for one value. shape covers width and height, so those go as
        // well - everything else on this workflow still comes from the schema.
        hideKeys={['prompt', 'segment_lengths', 'timeline', 'width', 'height',
                   'frame_rate', 'duration_seconds', 'start_second', 'end_second']}
                extraParams={() => {
          const timeline = buildTimeline(scenePrompt);
          const shape = SHAPES[canvasShape] ?? SHAPES.landscape;
          return {
            width: shape.width,
            height: shape.height,
            timeline_data: JSON.stringify(timeline),
            local_prompts: segments.map((s) => s.prompt.trim()).join(' | '),
            segment_lengths: segments.map((s) => Math.max(1, s.length)).join(','),
            start_frame: 0,
            end_frame: totalFrames,
            duration_frames: totalFrames,
            start_second: 0,
            end_second: totalFrames / fps,
            duration_seconds: totalFrames / fps,
            frame_rate: fps,
            display_mode: 'seconds',
            divisible_by: 32,
            img_compression: 0,
            use_custom_audio: audio.length > 0,
            use_custom_motion: motion.length > 0,
            override_audio: false,
            ref_image_notes: '',
          };
        }}
        extraTop={(
          <div className="space-y-4">
            {/* ---- the scene, and the canvas it plays on ---- */}
            <div className="workflow-section" id="workflow-prompt">
              <div className="workflow-section-header">
                <div className="workflow-section-title flex items-center gap-1.5">
                  Scene
                  <InfoTip text={
                    'The part that never changes: the look, the place, who is in it - everything '
                    + 'still true in the last frame. Leave the action out; camera moves and things '
                    + 'happening belong to the shots below.'
                  } />
                </div>
              </div>
              <textarea
                value={scenePrompt}
                onChange={(e) => setScenePrompt(e.target.value)}
                rows={3}
                className="fedda-input w-full rounded-lg px-3 py-2 text-sm text-white/90 resize-y"
                placeholder="Cinematic, late afternoon golden hour, anamorphic lens, fine film grain."
              />
              <div className="mt-2 flex items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-[0.12em] text-white/35">Canvas</span>
                {(Object.keys(SHAPES) as (keyof typeof SHAPES)[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setCanvasShape(key)}
                    className={`rounded-md border px-2.5 py-1 text-[11px] capitalize transition ${
                      canvasShape === key
                        ? 'border-sky-500/40 bg-sky-500/15 text-sky-200'
                        : 'border-white/10 text-white/45 hover:text-white/80'}`}
                  >
                    {key}
                  </button>
                ))}
                <span className="ml-1 text-[10px] text-white/30">
                  {SHAPES[canvasShape].width} x {SHAPES[canvasShape].height}
                </span>
              </div>
            </div>

            <div className="workflow-section">
              <div className="workflow-section-header">
                <div className="workflow-section-title flex items-center gap-1.5">
                  Storyboard
                  <InfoTip text={
                    'Each block is one shot. Its prompt describes only what happens in that '
                    + 'stretch; the global prompt above covers everything true of the whole clip. '
                    + 'H3 renders on a 17k+5 frame grid and rounds up, so the finished clip can be '
                    + 'slightly longer than the blocks add up to.'
                  } />
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {PRESETS.map((p, i) => (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => loadPreset(i)}
                      title={`Replace the storyboard with "${p.name}"`}
                      className={`rounded-md border px-2 py-0.5 text-[10px] transition ${
                        preset === i
                          ? 'border-white/25 bg-white/10 text-white/80'
                          : 'border-white/10 text-white/40 hover:text-white/75'}`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mb-1 flex flex-wrap items-center justify-end gap-2 text-[11px] text-white/45">
                <span>{segments.length} shots</span>
                <span className="text-white/25">·</span>
                <label className="flex items-center gap-1.5">
                  Clip length
                  <select
                    value={clip}
                    onChange={(e) => setClipLength(+e.target.value)}
                    className="rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-[11px]
                               text-white/75"
                    title="H3 renders only these lengths. Past the trained range it still works, but attention is quadratic - twice the frames is about four times the wait"
                  >
                    <optgroup label="What H3 was trained on">
                      {CLIP_LENGTHS.map((n) => (
                        <option key={n} value={n}>{fmt(n, fps)} · {n}f</option>
                      ))}
                    </optgroup>
                    <optgroup label="Longer — drifts, and the wait grows fast">
                      {LONG_CLIP_LENGTHS.map((n) => (
                        <option key={n} value={n}>{fmt(n, fps)} · {n}f</option>
                      ))}
                    </optgroup>
                  </select>
                </label>
              </div>

              <div data-tour="director-timeline">
              <DirectorTimeline
                segments={segments}
                setSegments={setSegments}
                motion={motion}
                setMotion={setMotion}
                audio={audio}
                setAudio={setAudio}
                fps={fps}
                selected={selected}
                setSelected={setSelected}
                refsOn={refsOn}
                onUpload={uploadFile}
              />
              </div>

              <div data-tour="director-shots" className="mt-3 flex gap-2 overflow-x-auto pb-1">
                {segments.map((seg, i) => (
                  <div
                    key={seg.id}
                    onClick={() => setSelected(i)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const f = e.dataTransfer.files?.[0];
                      if (f) void captionInto(i, f);
                    }}
                    className={`w-[248px] shrink-0 rounded-lg border p-2.5 transition ${
                      i === selected
                        ? 'border-white/25 bg-white/[0.04]'
                        : 'border-white/10 hover:border-white/20'}`}
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-white/70">Shot {i + 1}</span>
                      <span className="text-[11px] text-white/35">{fmt(seg.length, fps)}</span>
                      {captioning === i && (
                        <span className="text-[10px] text-white/40">writing…</span>
                      )}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); duplicateShot(i); }}
                        className="ml-auto text-white/35 transition hover:text-white"
                        title="Duplicate this shot"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeShot(i); }}
                        className="text-white/35 transition hover:text-red-300"
                        title="Delete this shot"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <textarea
                      value={seg.prompt}
                      onChange={(e) => patch(i, { prompt: e.target.value })}
                      onFocus={() => setSelected(i)}
                      rows={5}
                      placeholder="What happens in this shot — or drop a picture here and it writes itself"
                      className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-2
                                 text-[12px] text-white/85 placeholder:text-white/25"
                    />

                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {seg.imageFile ? (
                        <span className="flex items-center gap-1 rounded-md border border-white/15 px-2 py-1
                                         text-[11px] text-white/70">
                          <ImageIcon className="h-3 w-3" />
                          <span className="max-w-[160px] truncate">{seg.fileName || seg.imageFile}</span>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation();
                              patch(i, { imageFile: undefined, fileName: undefined, type: 'text' }); }}
                            className="text-white/40 hover:text-white"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            const inp = document.createElement('input');
                            inp.type = 'file';
                            inp.accept = 'image/*';
                            inp.onchange = () => {
                              const f = inp.files?.[0];
                              if (f) void captionInto(i, f);
                            };
                            inp.click();
                          }}
                          className="flex items-center gap-1 rounded-md border border-dashed border-white/15
                                     px-2 py-1 text-[11px] text-white/45 transition
                                     hover:border-white/30 hover:text-white/80"
                        >
                          <ImageIcon className="h-3 w-3" /> Reference image
                        </button>
                      )}
                      {seg.imageFile && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void describeAgain(i); }}
                          disabled={captioning === i}
                          className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1
                                     text-[11px] text-white/45 transition hover:text-white/80
                                     disabled:opacity-40"
                          title="Write this shot from the picture again, reading the shot before it"
                        >
                          <Wand2 className="h-3 w-3" /> Describe again
                        </button>
                      )}
                    </div>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={addShot}
                  className="flex w-[92px] shrink-0 flex-col items-center justify-center gap-1 rounded-lg
                             border border-dashed border-white/15 text-[11px] text-white/45 transition
                             hover:border-white/30 hover:text-white/80"
                >
                  <Plus className="h-4 w-4" />
                  Add shot
                </button>
              </div>

            </div>
          </div>
        )}

        extraBottom={(
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setShowMore(!showMore)}
              className="flex w-full items-center justify-between rounded-md border border-white/10
                         px-3 py-2 text-[11px] text-white/50 transition hover:text-white/80"
            >
              <span>Sound, references and timeline rate</span>
              <span>{showMore ? '−' : '+'}</span>
            </button>

            {showMore && (
            <>
            {/* ---- sound ---- */}
            <div className="workflow-section">
              <div className="workflow-section-header">
                <div className="workflow-section-title flex items-center gap-1.5">
                  Sound
                  <InfoTip text={
                    'H3 generates picture and sound together, so these describe what should be heard '
                    + 'rather than supplying it. Reference clips below are separate: those are real audio '
                    + 'the model listens to.'
                  } />
                </div>
              </div>
              <input
                value={soundscape}
                onChange={(e) => setSoundscape(e.target.value)}
                placeholder="Overall soundscape — wind, traffic, a room tone…"
                className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px]
                           text-white/85 placeholder:text-white/25"
              />
              <input
                value={music}
                onChange={(e) => setMusic(e.target.value)}
                placeholder="Score — music that is not in the room"
                className="mt-1.5 w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px]
                           text-white/85 placeholder:text-white/25"
              />
            </div>

            {/* ---- references ---- */}
            <div className="workflow-section">
              <div className="workflow-section-header">
                <div className="workflow-section-title flex items-center gap-1.5">
                  References
                  <InfoTip text={
                    'Reference mode loads a different 20 GB checkpoint (ref2va) instead of the normal one, '
                    + 'so it is a real switch, not a toggle you leave on. Off, keyframes still work — '
                    + 'characters, reference video and reference audio do not.'
                  } />
                </div>
                <button
                  type="button"
                  data-tour="director-refs"
                  onClick={() => setRefsOn(!refsOn)}
                  className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold transition ${
                    refsOn ? 'border-white/30 bg-white/10 text-white'
                           : 'border-white/10 text-white/45 hover:text-white/80'}`}
                >
                  {refsOn ? 'Refs ON — ref2va' : 'Refs OFF — fl2va'}
                </button>
              </div>

              {refsOn && (
                <div className="space-y-3">
                  <div>
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] text-white/50">
                      <Film className="h-3 w-3" /> Reference video
                      <span className="ml-auto">
                        {motion.length}/{MAX_REF_VIDEOS} · {motionSeconds.toFixed(1)}s
                        {motionSeconds > REF_VIDEO_TOTAL_SEC && (
                          <span className="text-amber-300/80"> · over {REF_VIDEO_TOTAL_SEC}s</span>
                        )}
                      </span>
                    </div>
                    <p className="text-[11px] text-white/35">
                      Drop a clip on the blue track above.
                    </p>
                  </div>

                  <div>
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] text-white/50">
                      <Music className="h-3 w-3" /> Reference audio
                      <span className="ml-auto">{audio.length}/{MAX_REF_AUDIOS}</span>
                    </div>
                    <p className="text-[11px] text-white/35">
                      Drop a file on the green track above.
                    </p>
                  </div>

                  <div>
                    <button
                      type="button"
                      onClick={() => setShowChars(!showChars)}
                      className="flex w-full items-center justify-between text-[11px] text-white/50 hover:text-white/80"
                    >
                      <span>Characters and objects ({subjects.length})</span>
                      <span>{showChars ? '−' : '+'}</span>
                    </button>
                    {showChars && (
                      <div className="mt-1.5 space-y-2">
                        {subjects.map((sub, i) => (
                          <div key={i} className="rounded-md border border-white/10 p-2">
                            <div className="flex gap-1.5">
                              <input
                                value={sub.shortName}
                                onChange={(e) => setSubjects((ss) => ss.map((x, j) =>
                                  j === i ? { ...x, shortName: e.target.value } : x))}
                                placeholder="Name used in the prompt"
                                className="flex-1 rounded border border-white/10 bg-black/30 px-2 py-1 text-[11px]"
                              />
                              <select
                                value={sub.kind}
                                onChange={(e) => setSubjects((ss) => ss.map((x, j) =>
                                  j === i ? { ...x, kind: e.target.value as Subject['kind'] } : x))}
                                className="rounded border border-white/10 bg-black/30 px-1.5 py-1 text-[11px]"
                              >
                                {SUBJECT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                              </select>
                              <button type="button"
                                      onClick={() => setSubjects((ss) => ss.filter((_, j) => j !== i))}
                                      className="text-white/40 hover:text-white">
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            <input
                              value={sub.description}
                              onChange={(e) => setSubjects((ss) => ss.map((x, j) =>
                                j === i ? { ...x, description: e.target.value } : x))}
                              placeholder="What they look like"
                              className="mt-1.5 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-[11px]"
                            />
                            <div className="mt-1.5 flex flex-wrap items-center gap-1">
                              {sub.images.map((img) => (
                                <span key={img}
                                      className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-white/60">
                                  <span className="max-w-[110px] truncate">{img}</span>
                                  <button type="button"
                                          onClick={() => setSubjects((ss) => ss.map((x, j) =>
                                            j === i ? { ...x, images: x.images.filter((y) => y !== img) } : x))}
                                          className="text-white/40 hover:text-white">
                                    <X className="h-2.5 w-2.5" />
                                  </button>
                                </span>
                              ))}
                              <button
                                type="button"
                                onClick={() => pickFile('image/*', (f) => setSubjects((ss) => ss.map((x, j) =>
                                  j === i ? { ...x, images: [...x.images, f] } : x)))}
                                className="rounded border border-dashed border-white/15 px-1.5 py-0.5 text-[10px]
                                           text-white/40 hover:border-white/30 hover:text-white/70"
                              >
                                + photo
                              </button>
                            </div>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => setSubjects((ss) => [...ss, emptySubject()])}
                          className="w-full rounded-md border border-dashed border-white/15 py-1 text-[11px]
                                     text-white/45 hover:border-white/30 hover:text-white/80"
                        >
                          + Character or object
                        </button>
                      </div>
                    )}
                  </div>

                  {refFiles > MAX_REF_FILES && (
                    <p className="text-[11px] text-amber-300/80">
                      {refFiles} reference files — H3 takes {MAX_REF_FILES} in total across images,
                      video and audio. The ones past the limit are dropped from the back.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* ---- timeline rate ---- */}
            <div className="workflow-section">
              <div className="workflow-section-header">
                <div className="workflow-section-title flex items-center gap-1.5">
                  Timeline rate
                  <InfoTip text={
                    'The rate the shot lengths above are counted in. H3 always renders at 24 fps — '
                    + 'this only decides how many frames a second of storyboard is worth, so at 12 the '
                    + 'same shot list makes a clip twice as long.'
                  } />
                </div>
                <div className="text-[11px] text-white/45">{fps} fps</div>
              </div>
              <input type="range" min={8} max={30} step={1} value={fps}
                     onChange={(e) => setFps(+e.target.value)} className="w-full" />
            </div>
            </>
            )}
          </div>
        )}
      />
    </>
  );
};
