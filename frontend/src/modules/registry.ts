import { Clapperboard, Images, Sparkles, Video, Wand2, type LucideIcon } from 'lucide-react';

/**
 * What the UI knows how to show, and which backend module has to be installed
 * for it to work.
 *
 * Three levels, each a plain list:
 *
 *     AREAS      the home screen        Image Workflows / Video Workflows
 *     FAMILIES   one model per card     Z-Image, and whatever comes next
 *     MODULES    one workflow per card  txt2img, inpaint, ControlNet, ...
 *
 * v3 flattened this. Its registry was 975 lines because every workflow needed a
 * row *and* a hand-written page, and the levels were three different components
 * that drifted apart. Here a level is a list and the card is one component, so
 * adding a model family is a row and adding a workflow is a row plus an entry
 * in `config/workflow_api.json`. No new file either way.
 *
 * `sourceModuleId` is the join to `config/modules.json`, and it is what makes
 * degradation real: the backend reports which modules an install actually has,
 * and a card whose source is missing is dropped rather than opening onto an
 * error. That is the path a core-only install takes through the whole tree.
 */

export type ModulePack = 'core' | 'booster';
export type ModuleArea = 'image' | 'video' | 'system';

/** Ids in `config/modules.json`. */
export type SourceModuleId =
  | 'core-shell'
  | 'z-image-core'
  | 'z-image-inpaint'
  | 'z-image-control'
  | 'z-image-detailed'
  | 'flux-krea'
  | 'minimax-h3'
  | 'minimax-h3-gguf'
  | 'ltx-23';

export const APP_VERSION_LABEL = 'FEDDA Hub v4.0';
export const ACTIVE_TAB_STORAGE_KEY = 'fedda_v4_active_tab';

// ------------------------------------------------------------------- level 1

export interface FeddaArea {
  id: ModuleArea;
  label: string;
  description: string;
  Icon: LucideIcon;
}

/** The home screen. Two now; audio and 3D are the obvious next ones. */
export const FEDDA_AREAS: FeddaArea[] = [
  {
    id: 'image',
    label: 'Image Workflows',
    description: 'Text, reference and LoRA-driven image generation on your own GPU.',
    Icon: Sparkles,
  },
  {
    id: 'video',
    label: 'Video Workflows',
    description: 'Clips from a prompt, with sound generated alongside the picture.',
    Icon: Video,
  },
];

// ------------------------------------------------------------------- level 2

export interface FeddaFamily {
  id: string;
  area: ModuleArea;
  label: string;
  description: string;
  Icon: LucideIcon;
  /**
   * The family shows when any one of these is installed. A family is not one
   * module: Z-Image's inpainting, ControlNet and upscale each ship separately,
   * and the card has to survive a core-only install that has none of them.
   */
  requiresAnyOf: SourceModuleId[];
}

export const FEDDA_FAMILIES: FeddaFamily[] = [
  {
    id: 'z-image',
    area: 'image',
    label: 'Z-Image',
    description: 'Z-Image Turbo. Fast, and the model the app is built around.',
    Icon: Wand2,
    requiresAnyOf: ['z-image-core', 'z-image-inpaint', 'z-image-control', 'z-image-detailed'],
  },
  {
    id: 'minimax-h3',
    area: 'video',
    label: 'MiniMax H3',
    description: 'Video with its own sound. Picture and stereo audio are generated together, not layered afterwards.',
    Icon: Clapperboard,
    requiresAnyOf: ['minimax-h3'],
  },
  {
    id: 'ltx-23',
    area: 'video',
    label: 'LTX 2.3',
    description: 'Ten ways to make a clip, picture and sound rendered together.',
    Icon: Clapperboard,
    requiresAnyOf: ['ltx-23'],
  },
  {
    id: 'flux',
    area: 'image',
    label: 'FLUX',
    description: 'Black Forest Labs. Several models, each with its own strengths.',
    Icon: Sparkles,
    requiresAnyOf: ['flux-krea'],
  },
];

// --------------------------------------------------- level 2b, when needed

export interface FeddaModelGroup {
  id: string;
  family: string;
  label: string;
  description: string;
  Icon: LucideIcon;
}

/**
 * Models inside a family, for families that have more than one.
 *
 * Z-Image is one model and its card opens straight onto workflows. FLUX is a
 * brand with eight - Krea, Klein, Kontext, SRPO and the rest - and each has
 * its own handful of workflows, so putting them all behind one card is the
 * flat list this whole arrangement exists to avoid.
 *
 * A family with nothing here behaves exactly as before.
 */
export const FEDDA_MODEL_GROUPS: FeddaModelGroup[] = [
  {
    id: 'flux-krea',
    family: 'flux',
    label: 'Krea',
    description: 'FLUX.1 Krea. Photographic by default, without the plastic look.',
    Icon: Wand2,
  },
  // Declared as a pair. A family with any model groups shows those instead
  // of its workflows, so adding only the GGUF one would strand the nine
  // full-weight workflows with no card leading to them.
  {
    id: 'minimax-h3-full',
    family: 'minimax-h3',
    label: 'Standard',
    description: 'Full weights. 19.5 GB a model - wants 24 GB of VRAM or more.',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-gguf',
    family: 'minimax-h3',
    label: 'GGUF',
    description: 'Quantised to 15.6 GB, the smallest published. For smaller cards.',
    Icon: Clapperboard,
  },
];

// ------------------------------------------------------------------- level 3

export interface FeddaModule {
  /** Also the tab id, and the key in `config/workflow_api.json`. All three. */
  id: string;
  sourceModuleId: SourceModuleId;
  family: string;
  /** Which model inside the family, when the family has more than one. */
  group?: string;
  area: ModuleArea;
  label: string;
  description: string;
  pack: ModulePack;
  tabs: string[];
  workflows?: string[];
  defaultTab: string;
  Icon: LucideIcon;
  requiresAnyOf?: SourceModuleId[];
  wip?: boolean;
  hidden?: boolean;
}

/**
 * Every workflow the app can open.
 *
 * The six Z-Image ones are groups of a single canvas file - the owner's
 * `Z IMAGE 6.json` - because the group is the unit there: one file carries
 * seven switchable modes, converted one per group by
 * `scripts/ui_to_api.py --all-groups --activate`. MiniMax H3 came the same way
 * from `MINIMAX H3.json`, which holds eight.
 */
export const FEDDA_MODULES: FeddaModule[] = [
  {
    id: 'z-image-txt2img',
    sourceModuleId: 'z-image-core',
    family: 'z-image',
    area: 'image',
    label: 'Text to Image',
    description: 'A picture from a prompt, with LoRAs and a face pass.',
    pack: 'core',
    tabs: ['z-image-txt2img'],
    workflows: ['z-image/txt2img.json'],
    defaultTab: 'z-image-txt2img',
    Icon: Sparkles,
  },
  {
    id: 'z-image-img2img',
    sourceModuleId: 'z-image-core',
    family: 'z-image',
    area: 'image',
    label: 'Image to Image',
    description: 'Redraw an image you supply. Denoise decides how far it may stray.',
    pack: 'core',
    tabs: ['z-image-img2img'],
    workflows: ['z-image/img2img.json'],
    defaultTab: 'z-image-img2img',
    Icon: Sparkles,
  },
  {
    id: 'z-image-inpaint',
    sourceModuleId: 'z-image-inpaint',
    family: 'z-image',
    area: 'image',
    label: 'Inpaint',
    description: 'Repaint the masked part of an image.',
    pack: 'booster',
    tabs: ['z-image-inpaint'],
    workflows: ['z-image/inpaint.json'],
    defaultTab: 'z-image-inpaint',
    Icon: Sparkles,
  },
  {
    id: 'z-image-inpaint-automask',
    sourceModuleId: 'z-image-inpaint',
    family: 'z-image',
    area: 'image',
    label: 'Inpaint · auto mask',
    description: 'Finds what to repaint by itself. Pick the parts, no hand masking.',
    pack: 'booster',
    tabs: ['z-image-inpaint-automask'],
    workflows: ['z-image/inpaint-automask.json'],
    defaultTab: 'z-image-inpaint-automask',
    Icon: Sparkles,
  },
  {
    id: 'z-image-controlnet',
    sourceModuleId: 'z-image-control',
    family: 'z-image',
    area: 'image',
    label: 'ControlNet',
    description: 'Follow the shape of a reference image - pose, edges or depth.',
    pack: 'booster',
    tabs: ['z-image-controlnet'],
    workflows: ['z-image/controlnet.json'],
    defaultTab: 'z-image-controlnet',
    Icon: Sparkles,
  },
  {
    id: 'z-image-detailed',
    sourceModuleId: 'z-image-detailed',
    family: 'z-image',
    area: 'image',
    label: 'Detailed',
    description: 'Text to image, then a tiled upscale pass over the result.',
    pack: 'booster',
    tabs: ['z-image-detailed'],
    workflows: ['z-image/detailed.json'],
    defaultTab: 'z-image-detailed',
    Icon: Sparkles,
  },

  {
    id: 'minimax-h3-txt2vid',
    sourceModuleId: 'minimax-h3',
    family: 'minimax-h3',
    group: 'minimax-h3-full',
    area: 'video',
    label: 'Text to Video',
    description: 'A clip from a prompt, with stereo sound generated in the same pass.',
    pack: 'booster',
    tabs: ['minimax-h3-txt2vid'],
    workflows: ['minimax-h3/txt2vid.json'],
    defaultTab: 'minimax-h3-txt2vid',
    Icon: Clapperboard,
  },

  {
    id: 'minimax-h3-img2vid',
    sourceModuleId: 'minimax-h3',
    family: 'minimax-h3',
    group: 'minimax-h3-full',
    area: 'video',
    label: 'Image to Video',
    description: 'Animate a still, with a second image steering the look.',
    pack: 'booster',
    tabs: ['minimax-h3-img2vid'],
    workflows: ['minimax-h3/img2vid.json'],
    defaultTab: 'minimax-h3-img2vid',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-video-edit',
    sourceModuleId: 'minimax-h3',
    family: 'minimax-h3',
    group: 'minimax-h3-full',
    area: 'video',
    label: 'Video Edit',
    description: 'Change something in a clip you already have, keeping the motion.',
    pack: 'booster',
    tabs: ['minimax-h3-video-edit'],
    workflows: ['minimax-h3/video-edit.json'],
    defaultTab: 'minimax-h3-video-edit',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-ref-images',
    sourceModuleId: 'minimax-h3',
    family: 'minimax-h3',
    group: 'minimax-h3-full',
    area: 'video',
    label: 'Eight References',
    description: 'Up to eight reference images steering one clip.',
    pack: 'booster',
    tabs: ['minimax-h3-ref-images'],
    workflows: ['minimax-h3/ref-images.json'],
    defaultTab: 'minimax-h3-ref-images',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-first-frame',
    sourceModuleId: 'minimax-h3',
    family: 'minimax-h3',
    group: 'minimax-h3-full',
    area: 'video',
    label: 'First Frame',
    description: 'One image becomes the opening frame, and the clip grows from it.',
    pack: 'booster',
    tabs: ['minimax-h3-first-frame'],
    workflows: ['minimax-h3/first-frame.json'],
    defaultTab: 'minimax-h3-first-frame',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-fflf',
    sourceModuleId: 'minimax-h3',
    family: 'minimax-h3',
    group: 'minimax-h3-full',
    area: 'video',
    label: 'First and Last Frame',
    description: 'Give it where to start and where to end; it makes the journey between.',
    pack: 'booster',
    tabs: ['minimax-h3-fflf'],
    workflows: ['minimax-h3/fflf.json'],
    defaultTab: 'minimax-h3-fflf',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-sing',
    sourceModuleId: 'minimax-h3',
    family: 'minimax-h3',
    group: 'minimax-h3-full',
    area: 'video',
    label: 'Sing',
    description: 'A portrait sings the track you give it, lips matched to the sound.',
    pack: 'booster',
    tabs: ['minimax-h3-sing'],
    workflows: ['minimax-h3/sing.json'],
    defaultTab: 'minimax-h3-sing',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-speak',
    sourceModuleId: 'minimax-h3',
    family: 'minimax-h3',
    group: 'minimax-h3-full',
    area: 'video',
    label: 'Speak',
    description: 'A portrait speaks the recording you give it.',
    pack: 'booster',
    tabs: ['minimax-h3-speak'],
    workflows: ['minimax-h3/speak.json'],
    defaultTab: 'minimax-h3-speak',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-director',
    sourceModuleId: 'minimax-h3',
    family: 'minimax-h3',
    group: 'minimax-h3-full',
    area: 'video',
    label: 'Director',
    description: 'A timeline of shots, each with its own moment and prompt, rendered as one clip.',
    pack: 'booster',
    tabs: ['minimax-h3-director'],
    workflows: ['minimax-h3/director.json'],
    defaultTab: 'minimax-h3-director',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-txt2vid-gguf',
    sourceModuleId: 'minimax-h3-gguf',
    family: 'minimax-h3',
    group: 'minimax-h3-gguf',
    area: 'video',
    label: 'Text to Video',
    description: 'A clip from a prompt, with stereo sound generated in the same pass.',
    pack: 'booster',
    tabs: ['minimax-h3-txt2vid-gguf'],
    workflows: ['minimax-h3-gguf/txt2vid.json'],
    defaultTab: 'minimax-h3-txt2vid-gguf',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-img2vid-gguf',
    sourceModuleId: 'minimax-h3-gguf',
    family: 'minimax-h3',
    group: 'minimax-h3-gguf',
    area: 'video',
    label: 'Image to Video',
    description: 'Animate a still, with a second image steering the look.',
    pack: 'booster',
    tabs: ['minimax-h3-img2vid-gguf'],
    workflows: ['minimax-h3-gguf/img2vid.json'],
    defaultTab: 'minimax-h3-img2vid-gguf',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-video-edit-gguf',
    sourceModuleId: 'minimax-h3-gguf',
    family: 'minimax-h3',
    group: 'minimax-h3-gguf',
    area: 'video',
    label: 'Video Edit',
    description: 'Change something in a clip you already have, keeping the motion.',
    pack: 'booster',
    tabs: ['minimax-h3-video-edit-gguf'],
    workflows: ['minimax-h3-gguf/video-edit.json'],
    defaultTab: 'minimax-h3-video-edit-gguf',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-ref-images-gguf',
    sourceModuleId: 'minimax-h3-gguf',
    family: 'minimax-h3',
    group: 'minimax-h3-gguf',
    area: 'video',
    label: 'Eight References',
    description: 'Up to eight reference images steering one clip.',
    pack: 'booster',
    tabs: ['minimax-h3-ref-images-gguf'],
    workflows: ['minimax-h3-gguf/ref-images.json'],
    defaultTab: 'minimax-h3-ref-images-gguf',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-first-frame-gguf',
    sourceModuleId: 'minimax-h3-gguf',
    family: 'minimax-h3',
    group: 'minimax-h3-gguf',
    area: 'video',
    label: 'First Frame',
    description: 'One image becomes the opening frame, and the clip grows from it.',
    pack: 'booster',
    tabs: ['minimax-h3-first-frame-gguf'],
    workflows: ['minimax-h3-gguf/first-frame.json'],
    defaultTab: 'minimax-h3-first-frame-gguf',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-fflf-gguf',
    sourceModuleId: 'minimax-h3-gguf',
    family: 'minimax-h3',
    group: 'minimax-h3-gguf',
    area: 'video',
    label: 'First and Last Frame',
    description: 'Give it where to start and where to end; it makes the journey between.',
    pack: 'booster',
    tabs: ['minimax-h3-fflf-gguf'],
    workflows: ['minimax-h3-gguf/fflf.json'],
    defaultTab: 'minimax-h3-fflf-gguf',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-sing-gguf',
    sourceModuleId: 'minimax-h3-gguf',
    family: 'minimax-h3',
    group: 'minimax-h3-gguf',
    area: 'video',
    label: 'Sing',
    description: 'A portrait sings the track you give it, lips matched to the sound.',
    pack: 'booster',
    tabs: ['minimax-h3-sing-gguf'],
    workflows: ['minimax-h3-gguf/sing.json'],
    defaultTab: 'minimax-h3-sing-gguf',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-speak-gguf',
    sourceModuleId: 'minimax-h3-gguf',
    family: 'minimax-h3',
    group: 'minimax-h3-gguf',
    area: 'video',
    label: 'Speak',
    description: 'A portrait speaks the recording you give it.',
    pack: 'booster',
    tabs: ['minimax-h3-speak-gguf'],
    workflows: ['minimax-h3-gguf/speak.json'],
    defaultTab: 'minimax-h3-speak-gguf',
    Icon: Clapperboard,
  },
  {
    id: 'minimax-h3-director-gguf',
    sourceModuleId: 'minimax-h3-gguf',
    family: 'minimax-h3',
    group: 'minimax-h3-gguf',
    area: 'video',
    label: 'Director',
    description: 'A timeline of shots, each with its own moment and prompt, rendered as one clip.',
    pack: 'booster',
    tabs: ['minimax-h3-director-gguf'],
    workflows: ['minimax-h3-gguf/director.json'],
    defaultTab: 'minimax-h3-director-gguf',
    Icon: Clapperboard,
  },
  {
    id: 'ltx-23-txt2vid',
    sourceModuleId: 'ltx-23',
    family: 'ltx-23',
    area: 'video',
    label: 'Text to Video (guided)',
    description: 'A clip from a prompt, guided by one reference picture that also sets the frame size.',
    pack: 'booster',
    tabs: ['ltx-23-txt2vid'],
    workflows: ['ltx-23/txt2vid.json'],
    defaultTab: 'ltx-23-txt2vid',
    Icon: Clapperboard,
  },
  {
    id: 'ltx-23-img2vid',
    sourceModuleId: 'ltx-23',
    family: 'ltx-23',
    area: 'video',
    label: 'Image to Video',
    description: 'Bring a still picture to life, with sound.',
    pack: 'booster',
    tabs: ['ltx-23-img2vid'],
    workflows: ['ltx-23/img2vid.json'],
    defaultTab: 'ltx-23-img2vid',
    Icon: Clapperboard,
  },
  {
    id: 'ltx-23-image-audio2vid',
    sourceModuleId: 'ltx-23',
    family: 'ltx-23',
    area: 'video',
    label: 'Image + Audio to Video',
    description: 'A portrait and a voice clip become a talking, singing shot.',
    pack: 'booster',
    tabs: ['ltx-23-image-audio2vid'],
    workflows: ['ltx-23/image-audio2vid.json'],
    defaultTab: 'ltx-23-image-audio2vid',
    Icon: Clapperboard,
  },
  {
    id: 'ltx-23-flf',
    sourceModuleId: 'ltx-23',
    family: 'ltx-23',
    area: 'video',
    label: 'First and Last Frame',
    description: 'Two stills, and the motion that gets from one to the other.',
    pack: 'booster',
    tabs: ['ltx-23-flf'],
    workflows: ['ltx-23/flf.json'],
    defaultTab: 'ltx-23-flf',
    Icon: Clapperboard,
  },
  {
    id: 'ltx-23-vid2vid-prompt',
    sourceModuleId: 'ltx-23',
    family: 'ltx-23',
    area: 'video',
    label: 'Video to Video',
    description: 'Redirect a clip you already have with a prompt.',
    pack: 'booster',
    tabs: ['ltx-23-vid2vid-prompt'],
    workflows: ['ltx-23/vid2vid-prompt.json'],
    defaultTab: 'ltx-23-vid2vid-prompt',
    Icon: Clapperboard,
  },
  {
    id: 'ltx-23-vid2vid-reference',
    sourceModuleId: 'ltx-23',
    family: 'ltx-23',
    area: 'video',
    label: 'Video to Video (reference)',
    description: 'Redirect a clip, holding it to a reference picture.',
    pack: 'booster',
    tabs: ['ltx-23-vid2vid-reference'],
    workflows: ['ltx-23/vid2vid-reference.json'],
    defaultTab: 'ltx-23-vid2vid-reference',
    Icon: Clapperboard,
  },
  {
    id: 'ltx-23-outpaint',
    sourceModuleId: 'ltx-23',
    family: 'ltx-23',
    area: 'video',
    label: 'Outpaint Video',
    description: 'Widen a clip past its own edges.',
    pack: 'booster',
    tabs: ['ltx-23-outpaint'],
    workflows: ['ltx-23/outpaint.json'],
    defaultTab: 'ltx-23-outpaint',
    Icon: Clapperboard,
  },
  {
    id: 'ltx-23-edit-anything',
    sourceModuleId: 'ltx-23',
    family: 'ltx-23',
    area: 'video',
    label: 'Edit Anything',
    description: 'Change one thing in a clip and leave the rest alone.',
    pack: 'booster',
    tabs: ['ltx-23-edit-anything'],
    workflows: ['ltx-23/edit-anything.json'],
    defaultTab: 'ltx-23-edit-anything',
    Icon: Clapperboard,
  },
  {
    id: 'ltx-23-prompt-relay',
    sourceModuleId: 'ltx-23',
    family: 'ltx-23',
    area: 'video',
    label: 'Prompt Relay',
    description: 'A timeline of prompts, each taking over for its own stretch.',
    pack: 'booster',
    tabs: ['ltx-23-prompt-relay'],
    workflows: ['ltx-23/prompt-relay.json'],
    defaultTab: 'ltx-23-prompt-relay',
    Icon: Clapperboard,
  },
  {
    id: 'ltx-23-first-frame-styler',
    sourceModuleId: 'ltx-23',
    family: 'ltx-23',
    area: 'video',
    label: 'First Frame Styler',
    description: 'Restyle the opening frame with FLUX 2 Klein, then animate it.',
    pack: 'booster',
    tabs: ['ltx-23-first-frame-styler'],
    workflows: ['ltx-23/first-frame-styler.json'],
    defaultTab: 'ltx-23-first-frame-styler',
    Icon: Clapperboard,
  },
  {
    id: 'flux-krea-gguf',
    sourceModuleId: 'flux-krea',
    family: 'flux',
    group: 'flux-krea',
    area: 'image',
    label: 'Krea GGUF',
    description: 'The quantised build. Same pictures, far less VRAM.',
    pack: 'booster',
    tabs: ['flux-krea-gguf'],
    workflows: ['flux-krea/gguf.json'],
    defaultTab: 'flux-krea-gguf',
    Icon: Sparkles,
  },
  {
    id: 'flux-krea-dev',
    sourceModuleId: 'flux-krea',
    family: 'flux',
    group: 'flux-krea',
    area: 'image',
    label: 'Krea Dev',
    description: 'The full-weight build, for when the card can take it.',
    pack: 'booster',
    tabs: ['flux-krea-dev'],
    workflows: ['flux-krea/dev.json'],
    defaultTab: 'flux-krea-dev',
    Icon: Sparkles,
  },
  {
    id: 'flux-krea-img2img',
    sourceModuleId: 'flux-krea',
    family: 'flux',
    group: 'flux-krea',
    area: 'image',
    label: 'Image to Image',
    description: 'Redraw a picture you already have.',
    pack: 'booster',
    tabs: ['flux-krea-img2img'],
    workflows: ['flux-krea/img2img.json'],
    defaultTab: 'flux-krea-img2img',
    Icon: Sparkles,
  },
  {
    id: 'flux-krea-depth',
    sourceModuleId: 'flux-krea',
    family: 'flux',
    group: 'flux-krea',
    area: 'image',
    label: 'ControlNet Depth',
    description: 'Keep the depth of a reference picture.',
    pack: 'booster',
    tabs: ['flux-krea-depth'],
    workflows: ['flux-krea/depth.json'],
    defaultTab: 'flux-krea-depth',
    Icon: Sparkles,
  },
  {
    id: 'flux-krea-openpose',
    sourceModuleId: 'flux-krea',
    family: 'flux',
    group: 'flux-krea',
    area: 'image',
    label: 'ControlNet Pose',
    description: 'Keep the pose of a reference picture.',
    pack: 'booster',
    tabs: ['flux-krea-openpose'],
    workflows: ['flux-krea/openpose.json'],
    defaultTab: 'flux-krea-openpose',
    Icon: Sparkles,
  },
  {
    id: 'flux-krea-normal',
    sourceModuleId: 'flux-krea',
    family: 'flux',
    group: 'flux-krea',
    area: 'image',
    label: 'ControlNet Normal',
    description: 'Keep the surface detail of a reference picture.',
    pack: 'booster',
    tabs: ['flux-krea-normal'],
    workflows: ['flux-krea/normal.json'],
    defaultTab: 'flux-krea-normal',
    Icon: Sparkles,
  },

  // Reachable by tab, off the card tree - it is a place, not a workflow.
  {
    id: 'gallery',
    sourceModuleId: 'core-shell',
    family: '',
    area: 'system',
    label: 'Gallery',
    description: 'Everything this machine has made.',
    pack: 'core',
    tabs: ['gallery'],
    defaultTab: 'gallery',
    Icon: Images,
    hidden: true,
  },
];
