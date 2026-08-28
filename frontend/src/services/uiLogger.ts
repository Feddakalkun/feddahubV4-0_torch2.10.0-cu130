export type UiLogLevel = 'info' | 'warn' | 'error' | 'success';

export interface UiLogEntry {
    id: string;
    ts: string;
    level: UiLogLevel;
    source: string;
    message: string;
    details?: string;
}

const STORAGE_KEY = 'fedda_ui_logs_v1';
const MAX_LOGS = 500;
const EVENT_NAME = 'fedda:ui-log';

function readLogs(): UiLogEntry[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeLogs(entries: UiLogEntry[]) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_LOGS)));
    } catch {
        // ignore storage failures
    }
}

function toDetails(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

export function addUiLog(level: UiLogLevel, source: string, message: string, details?: unknown): UiLogEntry {
    const entry: UiLogEntry = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        level,
        source,
        message,
        details: toDetails(details),
    };

    const all = [...readLogs(), entry];
    writeLogs(all);

    try {
        window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: entry }));
    } catch {
        // ignore event dispatch errors
    }

    return entry;
}

export function getUiLogs(): UiLogEntry[] {
    return readLogs();
}

export function clearUiLogs() {
    writeLogs([]);
    try {
        window.dispatchEvent(new CustomEvent(EVENT_NAME));
    } catch {
        // ignore
    }
}

export const UI_LOG_EVENT = EVENT_NAME;
