// Backend API response types — kept in sync with server.py endpoint shapes.

export interface MediaFile {
  filename: string;
  subfolder?: string;
  type?: string;
}

// POST /api/generate
export interface GenerateResponse {
  success: boolean;
  prompt_id: string;
  detail?: string;
}

// GET /api/generate/status/:promptId
export interface GenerateStatusResponse {
  status: 'pending' | 'running' | 'completed' | 'failed';
  videos?: MediaFile[];
  images?: MediaFile[];
  audios?: MediaFile[];
}

// GET /api/workflow/node-map/:workflowId
export interface NodeMapResponse {
  success: boolean;
  node_map: Record<string, unknown>;
}

// GET /api/workflow/list
export interface WorkflowListItem {
  id: string;
  name: string;
  description?: string;
  category?: string;
}

// GET /api/lora/list
export interface LoraListResponse {
  loras: string[];
}

// GET /api/hardware/stats
export interface HardwareStats {
  gpu_name?: string;
  gpu_vram_total_gb?: number;
  gpu_vram_used_gb?: number;
  gpu_utilization_pct?: number;
  ram_total_gb?: number;
  ram_used_gb?: number;
  cpu_pct?: number;
  status: 'ok' | 'error';
  error?: string;
}

// POST /api/chat
export interface ChatResponse {
  response: string;
  session_id?: string;
  tts?: {
    success: boolean;
    audio_url?: string;
    provider?: string;
    error?: string;
  };
}

// ComfyUI WebSocket callback types
export interface ComfyExecutionOutput {
  images?: MediaFile[];
  gifs?: MediaFile[];
  audio?: MediaFile[];
  [nodeId: string]: unknown;
}

export interface ComfyExecutionError {
  node_id?: string;
  node_type?: string;
  exception_message?: string;
  exception_type?: string;
  traceback?: string[];
}

export interface ComfyStatusData {
  exec_info: { queue_remaining: number };
}

export interface ComfyCallbacks {
  onExecuting?: (nodeId: string | null) => void;
  onProgress?: (nodeId: string, value: number, max: number) => void;
  onCompleted?: (promptId: string, output: ComfyExecutionOutput) => void;
  onExecutionError?: (data: ComfyExecutionError) => void;
  onPreview?: (blobUrl: string) => void;
  onStatus?: (data: ComfyStatusData) => void;
}
