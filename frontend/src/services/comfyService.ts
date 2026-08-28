// ComfyUI API Service
import { COMFY_API, BACKEND_API } from '../config/api';
import type { ComfyHistoryItem } from '../types/comfy';
import type { ComfyCallbacks, ComfyExecutionOutput, ComfyExecutionError, ComfyStatusData } from '../types/api';
import { addUiLog } from './uiLogger';

class ComfyUIService {
    public clientId: string;
    private ws: WebSocket | null = null;
    private reconnectAttempts: number = 0;

    private _callbacks: ComfyCallbacks | null = null;

    constructor() {
        this.clientId = `fedda_web_${Math.random().toString(36).substring(2, 10)}`;
    }

    private getComfyBaseUrl() {
        return (window as any).COMFY_PROXY_URL || '/comfy';
    }

    private getComfyWsUrl() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        return `${protocol}//${host}/comfy/ws`;
    }

    public connectWebSocket(callbacks: ComfyCallbacks) {
        this._callbacks = callbacks;
        this.reconnectAttempts = 0;
        this._connect();
        return () => {
            this._callbacks = null;
            if (this.ws) {
                this.ws.close();
                this.ws = null;
            }
        };
    }

    private _connect() {
        if (this.ws) return;

        const url = `${this.getComfyWsUrl()}?clientId=${this.clientId}`;
        const connectStartedAt = Date.now();
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            this.reconnectAttempts = 0;
            addUiLog('success', 'comfy', 'WebSocket Connected');
        };

        this.ws.onmessage = (event) => {
            // Binary message = preview image from ComfyUI (JPEG/PNG)
            if (event.data instanceof Blob) {
                const blob = event.data.slice(8); // skip 8-byte header (type + format)
                const url = URL.createObjectURL(blob);
                this._callbacks?.onPreview?.(url);
                return;
            }

            try {
                const msg = JSON.parse(event.data) as { type: string; data: Record<string, unknown> };
                switch (msg.type) {
                    case 'status':
                        this._callbacks?.onStatus?.(msg.data as unknown as ComfyStatusData);
                        break;
                    case 'executing':
                        this._callbacks?.onExecuting?.(msg.data.node as string | null);
                        break;
                    case 'progress':
                        this._callbacks?.onProgress?.(msg.data.node as string, msg.data.value as number, msg.data.max as number);
                        break;
                    case 'executed':
                        if (msg.data.prompt_id) {
                            this._callbacks?.onCompleted?.(msg.data.prompt_id as string, msg.data.output as ComfyExecutionOutput);
                        }
                        break;
                    case 'execution_error':
                        this._callbacks?.onExecutionError?.(msg.data as unknown as ComfyExecutionError);
                        break;
                }
            } catch (e) {
                // Ignore occasional malformed messages during reconnect bursts.
            }
        };

        this.ws.onclose = () => {
            this.ws = null;
            if (this._callbacks) {
                this.reconnectAttempts++;
                const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);
                setTimeout(() => this._connect(), delay);
            }
        };

        this.ws.onerror = () => {
            // During startup/reconnect we expect transient WS failures; avoid noisy console spam.
            const elapsed = Date.now() - connectStartedAt;
            if (this.reconnectAttempts >= 2 && elapsed > 1500) {
                console.warn('Comfy WebSocket reconnecting...');
            }
        };
    }

    public async queuePrompt(workflow: Record<string, unknown>): Promise<{ prompt_id: string }> {
        const resp = await fetch(`${this.getComfyBaseUrl()}${COMFY_API.ENDPOINTS.PROMPT}`, {
            method: 'POST',
            body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
            headers: { 'Content-Type': 'application/json' }
        });
        if (!resp.ok) throw new Error(`Queue failed: ${resp.statusText}`);
        return resp.json();
    }

    public async isAlive(): Promise<boolean> {
        try {
            const resp = await fetch(`${this.getComfyBaseUrl()}${COMFY_API.ENDPOINTS.SYSTEM_STATS}`, { cache: 'no-store' });
            return resp.ok;
        } catch {
            return false;
        }
    }

    public async interrupt(): Promise<void> {
        await fetch(`${this.getComfyBaseUrl()}${COMFY_API.ENDPOINTS.INTERRUPT}`, { method: 'POST' });
    }

    public async getHistory(promptId?: string): Promise<Record<string, ComfyHistoryItem>> {
        const url = promptId 
            ? `${this.getComfyBaseUrl()}${COMFY_API.ENDPOINTS.HISTORY}/${promptId}`
            : `${this.getComfyBaseUrl()}${COMFY_API.ENDPOINTS.HISTORY}`;
        const resp = await fetch(url);
        return resp.json();
    }

    public getImageUrl(img: { filename: string; subfolder?: string; type?: string }) {
        const params = new URLSearchParams({
            filename: img.filename,
            subfolder: img.subfolder || '',
            type: img.type || 'output'
        });
        return `${this.getComfyBaseUrl()}${COMFY_API.ENDPOINTS.VIEW}?${params}`;
    }

    public async getLoras(prefix?: string): Promise<string[]> {
        try {
            const url = prefix
                ? `${BACKEND_API.BASE_URL}${BACKEND_API.ENDPOINTS.LORA_LIST}?prefix=${encodeURIComponent(prefix)}`
                : `${BACKEND_API.BASE_URL}${BACKEND_API.ENDPOINTS.LORA_LIST}`;
            const resp = await fetch(url);
            const data = await resp.json();
            return data.loras || [];
        } catch (err) {
            console.error('Failed to fetch LoRAs', err);
            return [];
        }
    }
}

export const comfyService = new ComfyUIService();
