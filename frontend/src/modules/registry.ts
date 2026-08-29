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
  | 'minimax-h3';

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
];

// ------------------------------------------------------------------- level 3

export interface FeddaModule {
  /** Also the tab id, and the key in `config/workflow_api.json`. All three. */
  id: string;
  sourceModuleId: SourceModuleId;
  family: string;
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
    area: 'video',
    label: 'Text to Video',
    description: 'A clip from a prompt, with stereo sound generated in the same pass.',
    pack: 'booster',
    tabs: ['minimax-h3-txt2vid'],
    workflows: ['minimax-h3/txt2vid.json'],
    defaultTab: 'minimax-h3-txt2vid',
    Icon: Clapperboard,
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
