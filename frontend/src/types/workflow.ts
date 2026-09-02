/**
 * The shape `GET /api/workflow/schema/{id}` returns.
 *
 * Written by `backend/descriptor.py` from three sources: the mapping says
 * which node, the graph says what value it holds, and `object_info` says what
 * kind of control it is. Nothing in the frontend knows about any particular
 * workflow - it renders whatever comes back.
 */

export type FieldControl =
  | 'text'
  | 'number'
  | 'select'
  | 'chips'
  | 'toggle'
  | 'file'
  | 'audio'
  | 'lora';

/**
 * A sound file and the piece of it to use. `end` is what a person picks;
 * the node wants a length, and the backend converts on the way in.
 */
export interface AudioValue {
  file: string;
  start: number;
  end: number;
}

export interface WorkflowField {
  key: string;
  label: string;
  control: FieldControl;
  required?: boolean;

  /**
   * select / chips. An entry is normally the value itself; it carries its own
   * label when the value means nothing on its own - a switch index, say, where
   * 2 is "Pose" and the node has no way to know that.
   */
  options?: (string | number | { value: string | number; label: string })[];

  /** number - the node's own bounds, not a guess */
  min?: number;
  max?: number;
  step?: number;
  /** `seed` earns a dice button. Same control, different affordance. */
  role?: 'seed';

  /** text */
  multiline?: boolean;

  /** toggle - the node names its own states ("bbox" / "crop_region") */
  label_on?: string | null;
  label_off?: string | null;

  /** file */
  accept?: 'image' | 'audio' | 'video';
  /**
   * This slot reads the alpha channel as a mask, so the control offers a brush.
   * Declared by the mapping - LoadImage is the same node class either way.
   */
  mask?: boolean;

  default?: string | number | boolean | null;

  /**
   * Every node this one control drives. Plural because a seed has to reach the
   * sampler and the face pass together, or the same seed renders a different
   * face. The backend applies it; the frontend only sends the value.
   */
  node_ids?: string[];
  /** Something the user should know about this field, shown under it. */
  note?: string;
  /** What the slider should span - what people use, not what the node allows. */
  ui_min?: number;
  ui_max?: number;
  ui_step?: number;
  /** 'frames', with the rate it is counted at, so the control can show seconds. */
  unit?: string;
  fps?: number;
}

export interface WorkflowSchema {
  workflow_id: string;
  name: string;
  description?: string;
  module?: string;
  makes: 'image' | 'video';
  fields: WorkflowField[];
  /** A worked prompt for this model, keyed by field. Empty when none. */
  example?: Record<string, FieldValue>;
}

export type FieldValue = string | number | boolean | AudioValue | null;
