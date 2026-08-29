// ComfyUI API Configuration
// Desktop mode: uses .env.development with localhost URLs
// Docker mode: falls back to relative URLs through Nginx reverse proxy

const COMFY_BASE = import.meta.env.VITE_COMFY_URL || '/comfy';
const BACKEND_BASE = import.meta.env.VITE_BACKEND_URL || '';
const WS_PROTO = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_HOST = import.meta.env.VITE_COMFY_WS_URL || `${WS_PROTO}//${window.location.host}/comfy/ws`;

export const COMFY_API = {
    BASE_URL: COMFY_BASE,

    ENDPOINTS: {
        PROMPT: '/prompt',
        QUEUE: '/queue',
        HISTORY: '/history',
        VIEW: '/view',
        UPLOAD_IMAGE: '/upload/image',
        SYSTEM_STATS: '/system_stats',
        OBJECT_INFO: '/object_info',
        INTERRUPT: '/interrupt',
    },

    WS_URL: WS_HOST,
};

// Backend API Configuration (FastAPI server)
/**
 * Fired when a saved credential changes, so every badge showing that state can
 * refresh without a page reload.
 *
 * The Hugging Face token can be saved from the home-screen reminder or the top
 * bar, and each held its own copy of "is it configured" - so saving in one left
 * the other amber until the page reloaded and both remounted.
 *
 * An event rather than a context: whatever gets added later - a settings page, a
 * download dialog - can announce or listen without being wired into a provider.
 */
export const CREDENTIALS_CHANGED = 'fedda:credentials-changed';

export const announceCredentialChange = () => {
  window.dispatchEvent(new Event(CREDENTIALS_CHANGED));
};

export const BACKEND_API = {
    BASE_URL: BACKEND_BASE,

    ENDPOINTS: {
        FILES_LIST: '/api/files/list',
        FILES_DELETE: '/api/files/delete',
        FILES_CLEANUP: '/api/files/cleanup',
        RUNPOD_ANIMATE: '/api/runpod/animate',
        RUNPOD_STATUS: '/api/runpod/status',
        RUNPOD_DOWNLOAD: '/api/runpod/download',
        LORA_DOWNLOAD_STATUS: '/api/lora/download-status',
        LORA_DOWNLOADS: '/api/lora/downloads',
        LORA_INSTALLED: '/api/lora/installed',
        LORA_IMPORT_URL: '/api/lora/import-url',
        LORA_IMPORT_STATUS: '/api/lora/import-status',
        LORA_UPLOAD_LOCAL: '/api/lora/upload-local',
        LORA_CONFIG: '/api/lora/config',
        LORA_PREVIEW: '/api/lora/preview',
        LORA_SHEET: '/api/lora/sheet',
        SETTINGS_FOLDERS: '/api/settings/folders',
        SETTINGS_CIVITAI_KEY: '/api/settings/civitai-key',
        SETTINGS_CIVITAI_KEY_STATUS: '/api/settings/civitai-key/status',
        SETTINGS_HF_TOKEN: '/api/settings/hf-token',
        SETTINGS_HF_TOKEN_STATUS: '/api/settings/hf-token/status',
        // Venice is not in v4. The fifteen endpoints these named live in v3's
        // server.py and none of them have been ported, so listing them here
        // was a menu of routes that answer 404. They come back with the
        // backend, not before it.
        CHAT: '/api/chat',
        CHAT_HISTORY: '/api/chat/history',
        CHAT_RESET: '/api/chat/reset',
        CHAT_FISH_MODELS: '/api/chat/fish/models',
        CHAT_FISH_DOWNLOAD: '/api/chat/fish/download',
        CHAT_VOICE_CLONE_REFERENCE: '/api/chat/voice-clone/reference',
        CHAT_TTS: '/api/chat/tts',
        CHAT_LTX_COPILOT: '/api/chat/ltx-copilot',
        AGENT_SETTINGS: '/api/agent/settings',
        AGENT_RUN: '/api/agent/run',
        AGENT_APPROVE: '/api/agent/approve',
        AGENT_DENY: '/api/agent/deny',
        AGENT_RUN_STATUS: '/api/agent/runs',
        AGENT_ROLLBACK: '/api/agent/rollback',
        COMFY_REFRESH_MODELS: '/api/comfy/refresh-models',
        AUDIO_TRANSCRIBE: '/api/audio/transcribe',
        AUDIO_TTS: '/api/audio/tts',
        AUDIO_REFERENCE_INFO: '/api/audio/reference-info',
        VIDEO_LIPSYNC: '/api/video/lipsync',
        VIDEO_ANALYZE_PROMPT: '/api/video/analyze-image-prompt',
        OLLAMA_VISION_MODELS: '/api/ollama/vision-models',
        OLLAMA_MODELS: '/api/ollama/models',
        OLLAMA_PROMPT: '/api/ollama/prompt',
        OLLAMA_CAPTION: '/api/ollama/caption',
        WORKFLOW_MEMORY: '/api/workflow-memory',
        UI_AGENT_WORKFLOWS: '/api/ui-agent/workflows',
        UI_AGENT_PLAN: '/api/ui-agent/plan',
        UI_AGENT_PREPARE: '/api/ui-agent/prepare',
        UI_AGENT_RUN: '/api/ui-agent/run',
        UI_AGENT_MEMPALACE_STATUS: '/api/ui-agent/mempalace/status',
        HARDWARE_STATS: '/api/hardware/stats',
        WORKFLOW_LIST: '/api/workflow/list',
        WORKFLOW_MODEL_STATUS: '/api/workflow/model-status',
        GENERATE: '/api/generate',
        GENERATE_STATUS: '/api/generate/status',
        LORA_LIST: '/api/lora/list',
        MEDIA_DOWNLOAD_VIDEO: '/api/media/download-video',
    },
};

/** True when running on RunPod (detected via proxy hostname) */
export const IS_RUNPOD = /\.proxy\.runpod\.net$/i.test(window.location.host);

export const APP_CONFIG = {
    NAME: 'FEDDA',
    VERSION: '0.1.0',
    DESCRIPTION: 'PREMIUM COMFYUI FRONTEND',
};

export const MODELS = {
    IMAGE: [
        { id: 'image-generate', label: 'GENERATE', icon: 'Sparkles', category: 'Z-IMAGE' },
        { id: 'image-hq', label: 'HQ IMAGE', icon: 'Layers', category: 'Z-IMAGE' },
        { id: 'image-img2img', label: 'IMG2IMG', icon: 'Image', category: 'Z-IMAGE' },
        { id: 'image-mood-edit', label: 'MOOD EDIT', icon: 'Sun', category: 'Z-IMAGE' },
        { id: 'image-inpaint', label: 'INPAINT', icon: 'Paintbrush', category: 'Z-IMAGE' },
        { id: 'image-autoinpaint', label: 'AUTO INPAINT', icon: 'Wand2', category: 'Z-IMAGE' },
        { id: 'image-metadata', label: 'METADATA', icon: 'FileText', category: 'Z-IMAGE' },
    ],
    QWEN: [
        { id: 'qwen-angle', label: 'MULTIANGLE', icon: 'Box', category: 'QWEN' },
    ],
    FLUX2KLEIN: [
        { id: 'flux2klein-image-edit', label: 'IMAGE EDIT', icon: 'Image', category: 'FLUX2KLEIN' },
        { id: 'flux2klein-2-referenceimg', label: '2 REFERENCE IMG', icon: 'Layers', category: 'FLUX2KLEIN' },
        { id: 'flux2klein-multiangle', label: 'MULTIANGLE', icon: 'Box', category: 'FLUX2KLEIN' },
    ],
    LTXHUB: [
        { id: 'ltx-generate-i2v', label: 'Generate I2V', icon: 'ImagePlay', category: 'GENERATE', source: 'LTX2.3', mapsTo: 'ltx-i2v' },
        { id: 'ltx-generate-t2v', label: 'Generate T2V', icon: 'Type', category: 'GENERATE', source: 'LTX2.3', mapsTo: 'ltx-t2v' },
        { id: 'ltx-edit-i2v-sound', label: 'I2V + Sound', icon: 'Volume2', category: 'EDIT', source: 'LTX2', mapsTo: 'ltx2-i2v-sound' },
        { id: 'ltx-motion-lipsync', label: 'Lipsync Pro', icon: 'Mic2', category: 'MOTION', source: 'LTX2', mapsTo: 'ltx2-lipsync' },
        { id: 'ltx23-av', label: 'AV 5-in-1', icon: 'Music', category: 'GENERATE', source: 'LTX2.3', mapsTo: 'ltx23-av' },
    ],
    VIDEO: [
        // Keep Video menu focused on WAN utilities.
        // LTX entries live in MODELS.LTXHUB to avoid duplicated navigation paths.
        { id: 'lipsync', label: 'Lipsync', icon: 'Mic2', category: 'WAN' },
        { id: 'scene-builder', label: 'Scene Builder', icon: 'Film', category: 'WAN' },
    ],
    AUDIO: [
        { id: 'ace-step', label: 'ACE-Step 1.5', icon: 'Music' },
    ],
    PONYXL: [
        { id: 'ponyxl-generate', label: 'GENERATE', icon: 'Sparkles', category: 'PONYXL' },
    ],
};


