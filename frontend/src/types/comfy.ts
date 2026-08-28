// ComfyUI API Types

export interface ComfyNode {
  id: string;
  type: string;
  inputs: Record<string, any>;
  outputs: Record<string, any>;
}

export interface ComfyWorkflow {
  nodes: ComfyNode[];
  metadata?: {
    name?: string;
    description?: string;
  };
}

export interface ComfyPrompt {
  prompt: Record<string, any>;
  client_id?: string;
}

export interface ComfyQueueItem {
  prompt_id: string;
  number: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface ComfyHistoryItem {
  prompt: any[];
  outputs: Record<string, ComfyOutput>;
  status: {
    status_str: string;
    completed: boolean;
  };
}

export interface ComfyOutput {
  images?: Array<{
    filename: string;
    subfolder: string;
    type: string;
  }>;
  gifs?: Array<{
    filename: string;
    subfolder: string;
    type: string;
  }>;
}

export interface GenerationConfig {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  seed?: number;
  model?: string;
}
