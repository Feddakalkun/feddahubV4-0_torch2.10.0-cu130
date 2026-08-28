// Global ComfyUI Execution Context
// Tracks real-time workflow execution with human-readable node names
import { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { comfyService } from '../services/comfyService';

type ExecutionState = 'idle' | 'executing' | 'done' | 'error';

interface ExecutionError {
    type: string;
    message: string;
    nodeType?: string;
    nodeId?: string;
}

interface OutputFile {
    filename: string;
    subfolder: string;
    type: string;
}

interface DownloadFileInfo {
    filename?: string;
    folder?: string;
    exists?: boolean;
    size_bytes?: number;
}

interface NodeInfo {
    name: string;
    classType: string;
    isDownloader?: boolean;
    downloaderType?: string;
    downloadTotal?: number;
    downloadMissing?: number;
    downloadFiles?: DownloadFileInfo[];
}

interface ComfyExecutionContextType {
    state: ExecutionState;
    currentNodeName: string;
    currentNodeId: string | null;
    progress: number; // 0-100
    isDownloaderNode: boolean;
    currentDownloaderInfo: NodeInfo | null;
    error: ExecutionError | null;
    totalNodes: number;
    completedNodes: number;
    lastCompletedPromptId: string | null;
    outputReadyCount: number; // increments on each 'executed' event (per output node)
    lastOutputImages: OutputFile[]; // images from latest executed event
    lastOutputVideos: OutputFile[]; // videos/gifs from latest executed event
    previewUrl: string | null; // live preview image during sampling
    overallProgress: number; // 0-100 workflow-level progress
    elapsedMs: number;          // wall time since the run started
    secondsPerStep: number | null;  // smoothed s/it, null until two steps are seen
    etaMs: number | null;       // remaining steps x secondsPerStep
    // Queue a workflow: builds node map, sends to ComfyUI, returns prompt_id
    queueWorkflow: (workflow: Record<string, any>) => Promise<string>;
    // Register a pre-built node map (used when submitting via /api/generate instead of queueWorkflow)
    registerNodeMap: (nodeMap: Record<string, NodeInfo>) => void;
    // Start executing state immediately (use when submitting via /api/generate so the bar shows during model loading)
    startExecution: () => void;
    /**
     * The counterpart to startExecution, for the same callers.
     *
     * Both ways out of `executing` are websocket events, and those only arrive
     * for jobs this browser queued. A run submitted through /api/generate polls
     * for its own result, so without this the bar stayed on LOADING… forever -
     * which is exactly what it did.
     */
    finishExecution: () => void;
    cancelExecution: () => Promise<void>;
    clearOutputs: () => void;
}

const ComfyExecutionContext = createContext<ComfyExecutionContextType | null>(null);

export const useComfyExecution = () => {
    const ctx = useContext(ComfyExecutionContext);
    if (!ctx) throw new Error('useComfyExecution must be used within ComfyExecutionProvider');
    return ctx;
};

// Regex to detect downloader/model-fetching nodes
const DOWNLOADER_REGEX = /download|linker|fetch|huggingface|hf_hub|model.*load/i;

// Clean up class_type into readable name: "KSampler" -> "KSampler", "CLIPTextEncode" -> "CLIP Text Encode"
function cleanClassName(classType: string): string {
    return classType
        .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase split
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYMWord split
        .replace(/_/g, ' ')
        .trim();
}

// Build a map of nodeId -> human-readable name from workflow JSON
function parseDownloaderFiles(node: any): DownloadFileInfo[] {
    const raw = String(node?.inputs?.download_links || '').trim();
    if (!raw) return [];
    const seen = new Set<string>();
    return raw.split(/\r?\n/).flatMap((line) => {
        const clean = line.trim();
        if (!clean || clean.startsWith('#')) return [];
        const parts = clean.split(/\s+/);
        if (parts.length < 2) return [];
        const urlPath = (parts[0] || '').split('?', 1)[0].replace(/\/+$/, '');
        const filename = parts[2] || urlPath.split('/').pop() || '';
        const folder = (parts[1] || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const key = `${folder.toLowerCase()}/${filename.toLowerCase()}`;
        if (!filename || !folder || seen.has(key)) return [];
        seen.add(key);
        return [{ filename, folder }];
    });
}

function buildNodeMap(workflow: Record<string, any>): Record<string, NodeInfo> {
    const map: Record<string, NodeInfo> = {};
    for (const [nodeId, node] of Object.entries(workflow)) {
        if (!node || typeof node !== 'object') continue;
        const classType = node.class_type || 'Unknown';
        const metaTitle = node._meta?.title;
        const name = metaTitle || cleanClassName(classType);
        const isDownloader = classType === 'HuggingFaceDownloader' || DOWNLOADER_REGEX.test(classType) || DOWNLOADER_REGEX.test(name);
        const downloadFiles = classType === 'HuggingFaceDownloader' ? parseDownloaderFiles(node) : undefined;
        map[nodeId] = {
            name,
            classType,
            isDownloader,
            downloaderType: classType === 'HuggingFaceDownloader' ? 'huggingface' : undefined,
            downloadTotal: downloadFiles?.length,
            downloadFiles,
        };
    }
    return map;
}

function isVideoFile(filename?: string): boolean {
    const lower = String(filename || '').toLowerCase();
    return lower.endsWith('.mp4') || lower.endsWith('.webm') || lower.endsWith('.mov') || lower.endsWith('.mkv');
}

export const ComfyExecutionProvider = ({ children }: { children: React.ReactNode }) => {
    const [state, setState] = useState<ExecutionState>('idle');
    const [currentNodeName, setCurrentNodeName] = useState('');
    const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
    const [progress, setProgress] = useState(0);
    // A percentage alone does not tell you whether to wait or go and do
    // something else. Elapsed time, s/it and an ETA do, and ComfyUI already
    // sends the step index and step count needed to derive all three.
    const [elapsedMs, setElapsedMs] = useState(0);
    const [secondsPerStep, setSecondsPerStep] = useState<number | null>(null);
    const [etaMs, setEtaMs] = useState<number | null>(null);
    const runStartedAtRef = useRef<number | null>(null);
    const lastStepRef = useRef<{ value: number; at: number } | null>(null);
    const [isDownloaderNode, setIsDownloaderNode] = useState(false);
    const [currentDownloaderInfo, setCurrentDownloaderInfo] = useState<NodeInfo | null>(null);
    const [error, setError] = useState<ExecutionError | null>(null);
    const [totalNodes, setTotalNodes] = useState(0);
    const [completedNodes, setCompletedNodes] = useState(0);

    const [lastCompletedPromptId, setLastCompletedPromptId] = useState<string | null>(null);
    const [outputReadyCount, setOutputReadyCount] = useState(0);
    const [lastOutputImages, setLastOutputImages] = useState<OutputFile[]>([]);
    const [lastOutputVideos, setLastOutputVideos] = useState<OutputFile[]>([]);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);

    const nodeMapRef = useRef<Record<string, NodeInfo>>({});
    const prevPreviewRef = useRef<string | null>(null);
    const executedNodesRef = useRef<Set<string>>(new Set());
    const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const activePromptIdRef = useRef<string | null>(null);
    const cancelledRef = useRef(false);
    const stateRef = useRef<ExecutionState>('idle');

    // Helper to safely transition to done state
    const transitionToDone = useCallback(() => {
        setState('done');
        stateRef.current = 'done';
        setCurrentNodeName('Complete');
        setProgress(100);
        setIsDownloaderNode(false);
        setCurrentDownloaderInfo(null);
        if (prevPreviewRef.current) { URL.revokeObjectURL(prevPreviewRef.current); prevPreviewRef.current = null; }
        setPreviewUrl(null);

        if (activePromptIdRef.current) {
            setLastCompletedPromptId(activePromptIdRef.current);
        }

        if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
        doneTimerRef.current = setTimeout(() => {
            setState('idle');
            stateRef.current = 'idle';
            setCurrentNodeName('');
            setCurrentNodeId(null);
            setProgress(0);
            setCompletedNodes(0);
            setTotalNodes(0);
            setCurrentDownloaderInfo(null);
            executedNodesRef.current.clear();
        }, 5000);
    }, []);

    // Connect WebSocket once on mount
    useEffect(() => {
        const disconnect = comfyService.connectWebSocket({
            onExecuting: (nodeId: string | null) => {
                // Ignore WS messages after cancel
                if (cancelledRef.current) return;

                // Clear any pending done timer
                if (doneTimerRef.current) {
                    clearTimeout(doneTimerRef.current);
                    doneTimerRef.current = null;
                }

                if (!nodeId) {
                    transitionToDone();
                    return;
                }

                setState('executing');
                stateRef.current = 'executing';
                setCurrentNodeId(nodeId);
                setError(null);

                // Track completed nodes
                executedNodesRef.current.add(nodeId);
                setCompletedNodes(executedNodesRef.current.size);

                // Look up human-readable name
                const nodeInfo = nodeMapRef.current[nodeId];
                if (nodeInfo) {
                    setCurrentNodeName(nodeInfo.name);
                    const downloader = !!nodeInfo.isDownloader || DOWNLOADER_REGEX.test(nodeInfo.classType) || DOWNLOADER_REGEX.test(nodeInfo.name);
                    setIsDownloaderNode(downloader);
                    setCurrentDownloaderInfo(downloader ? nodeInfo : null);
                } else {
                    setCurrentNodeName(`Node ${nodeId}`);
                    setIsDownloaderNode(false);
                    setCurrentDownloaderInfo(null);
                }

                // Reset per-node progress
                setProgress(0);
            },

            onProgress: (_node: string, value: number, max: number) => {
                if (cancelledRef.current) return;
                setProgress(Math.round((value / max) * 100));

                // Rate comes from the gap between consecutive steps, smoothed:
                // the first step of a sampler includes model load and would
                // otherwise poison the estimate for the whole run.
                const now = Date.now();
                const prev = lastStepRef.current;
                lastStepRef.current = { value, at: now };
                if (prev && value > prev.value) {
                    const perStep = (now - prev.at) / 1000 / (value - prev.value);
                    setSecondsPerStep((old) => {
                        const next = old == null ? perStep : old * 0.7 + perStep * 0.3;
                        setEtaMs(Math.max(0, max - value) * next * 1000);
                        return next;
                    });
                }
            },

            onCompleted: (promptId: string, output: Record<string, any>) => {
                if (cancelledRef.current) return;
                activePromptIdRef.current = promptId;
                setLastCompletedPromptId(promptId);
                
                // Accumulate ALL image outputs (from both final SaveImage and intermediate PreviewImage nodes)
                if (output?.images && Array.isArray(output.images)) {
                    const videosFromImages = output.images.filter((f: OutputFile) => isVideoFile(f?.filename));
                    const stillImages = output.images.filter((f: OutputFile) => !isVideoFile(f?.filename));
                    
                    if (stillImages.length > 0) {
                        setLastOutputImages(prev => [...prev, ...stillImages]);
                    }
                    if (videosFromImages.length > 0) {
                        setLastOutputVideos(prev => [...prev, ...videosFromImages]);
                    }
                }
                
                // Accumulate videos (VHS_VideoCombine outputs as 'gifs' or 'videos')
                if (output?.gifs && Array.isArray(output.gifs)) {
                    setLastOutputVideos(prev => [...prev, ...output.gifs]);
                }
                if (output?.videos && Array.isArray(output.videos)) {
                    setLastOutputVideos(prev => [...prev, ...output.videos]);
                }
                setOutputReadyCount(prev => prev + 1);
            },

            onExecutionError: (errData: Record<string, any>) => {
                if (cancelledRef.current) return;
                const message =
                    errData?.exception_message ||
                    errData?.message ||
                    'Workflow execution failed';
                setState('error');
                stateRef.current = 'error';
                setError({
                    type: 'execution_error',
                    message: String(message).trim(),
                    nodeType: errData?.node_type,
                    nodeId: errData?.node_id,
                });
                setCurrentNodeName(errData?.node_type ? `Error in ${errData.node_type}` : 'Execution Error');
                setCurrentNodeId(errData?.node_id ? String(errData.node_id) : null);
                setProgress(0);
                setIsDownloaderNode(false);
                setCurrentDownloaderInfo(null);
            },

            onPreview: (blobUrl: string) => {
                if (cancelledRef.current) return;
                // Revoke previous blob URL to prevent memory leaks
                if (prevPreviewRef.current) URL.revokeObjectURL(prevPreviewRef.current);
                prevPreviewRef.current = blobUrl;
                setPreviewUrl(blobUrl);
            },

            onStatus: (data: Record<string, any>) => {
                // Check if queue empty while we were executing
                if (data?.exec_info?.queue_remaining === 0 && stateRef.current === 'executing') {
                    transitionToDone();
                }
            },
        });

        return () => disconnect();
    }, [transitionToDone]);

    // Transition immediately to 'executing' when pages submit via /api/generate.
    // Without this, the top bar stays idle during long GGUF model loading phases
    // because ComfyUI's event loop is blocked and sends no WebSocket events until sampling starts.
    // One interval for the whole app rather than a timer per consumer, and it
    // only exists while something is actually running.
    useEffect(() => {
        if (state !== 'executing') return;
        const id = setInterval(() => {
            if (runStartedAtRef.current) setElapsedMs(Date.now() - runStartedAtRef.current);
        }, 500);
        return () => clearInterval(id);
    }, [state]);

    // Only acts while a run is in flight, so a late websocket event and a
    // finished poll cannot fight over the state.
    const finishExecution = useCallback(() => {
        if (stateRef.current === 'executing') transitionToDone();
    }, [transitionToDone]);

    const startExecution = useCallback(() => {
        cancelledRef.current = false;
        if (doneTimerRef.current) {
            clearTimeout(doneTimerRef.current);
            doneTimerRef.current = null;
        }
        executedNodesRef.current.clear();
        runStartedAtRef.current = Date.now();
        lastStepRef.current = null;
        setElapsedMs(0);
        setSecondsPerStep(null);
        setEtaMs(null);
        setCompletedNodes(0);
        setOutputReadyCount(0);
        setLastOutputImages([]);
        setLastOutputVideos([]);
        if (prevPreviewRef.current) { URL.revokeObjectURL(prevPreviewRef.current); prevPreviewRef.current = null; }
        setPreviewUrl(null);
        setState('executing');
        stateRef.current = 'executing';
        setCurrentNodeName('Loading...');
        setCurrentNodeId(null);
        setProgress(0);
        setError(null);
        setIsDownloaderNode(false);
        setCurrentDownloaderInfo(null);
    }, []);

    // Cancel/interrupt the current execution
    const cancelExecution = useCallback(async () => {
        try {
            cancelledRef.current = true;
            await comfyService.interrupt();
            // Clear any pending done timer
            if (doneTimerRef.current) {
                clearTimeout(doneTimerRef.current);
                doneTimerRef.current = null;
            }
            setState('idle');
            stateRef.current = 'idle';
            setCurrentNodeName('');
            setCurrentNodeId(null);
            setProgress(0);
            setError(null);
            setIsDownloaderNode(false);
            setCurrentDownloaderInfo(null);
            setCompletedNodes(0);
            setTotalNodes(0);
            executedNodesRef.current.clear();
            if (prevPreviewRef.current) { URL.revokeObjectURL(prevPreviewRef.current); prevPreviewRef.current = null; }
            setPreviewUrl(null);
        } catch (err: any) {
            console.error('Cancel failed:', err);
        }
    }, []);

    const clearOutputs = useCallback(() => {
        setLastOutputImages([]);
        setLastOutputVideos([]);
        setLastCompletedPromptId(null);
        setOutputReadyCount(0);
        if (prevPreviewRef.current) { URL.revokeObjectURL(prevPreviewRef.current); prevPreviewRef.current = null; }
        setPreviewUrl(null);
    }, []);

    // Queue workflow with node map building
    const queueWorkflow = useCallback(async (workflow: Record<string, any>): Promise<string> => {
        // Reset cancelled flag so WS messages work again
        cancelledRef.current = false;

        // Clear previous done timer so it doesn't interrupt this run
        if (doneTimerRef.current) {
            clearTimeout(doneTimerRef.current);
            doneTimerRef.current = null;
        }

        // Build node map from workflow
        const nodeMap = buildNodeMap(workflow);
        nodeMapRef.current = nodeMap;
        setTotalNodes(Object.keys(nodeMap).length);
        executedNodesRef.current.clear();
        runStartedAtRef.current = Date.now();
        lastStepRef.current = null;
        setElapsedMs(0);
        setSecondsPerStep(null);
        setEtaMs(null);
        setCompletedNodes(0);
        setOutputReadyCount(0);
        setLastOutputImages([]);
        setLastOutputVideos([]);
        if (prevPreviewRef.current) { URL.revokeObjectURL(prevPreviewRef.current); prevPreviewRef.current = null; }
        setPreviewUrl(null);

        // Reset state
        setState('executing');
        stateRef.current = 'executing';
        setCurrentNodeName('Queuing...');
        setCurrentNodeId(null);
        setProgress(0);
        setError(null);
        setIsDownloaderNode(false);
        setCurrentDownloaderInfo(null);

        try {
            const result = await comfyService.queuePrompt(workflow);
            activePromptIdRef.current = result.prompt_id;
            return result.prompt_id;
        } catch (err: any) {
            // Parse ComfyUI error response
            let execError: ExecutionError = {
                type: 'queue_error',
                message: err.message || 'Failed to queue workflow',
            };

            // Try to extract specific node error from ComfyUI response
            try {
                if (err.message?.includes('missing_node_type')) {
                    const match = err.message.match(/Node '(.+?)' not found/);
                    execError = {
                        type: 'missing_node_type',
                        message: match ? `Missing node: "${match[1]}"` : 'Missing custom node',
                        nodeType: match?.[1],
                    };
                }
            } catch {}

            setState('error');
            stateRef.current = 'error';
            setError(execError);
            setCurrentNodeName('Error');
            throw err;
        }
    }, []);

    const overallProgress = totalNodes > 0 ? Math.round((completedNodes / totalNodes) * 100) : 0;

    return (
        <ComfyExecutionContext.Provider value={{
            state,
            currentNodeName,
            currentNodeId,
            progress,
            isDownloaderNode,
            currentDownloaderInfo,
            error,
            totalNodes,
            completedNodes,
            lastCompletedPromptId,
            outputReadyCount,
            lastOutputImages,
            lastOutputVideos,
            previewUrl,
            overallProgress,
            elapsedMs,
            secondsPerStep,
            etaMs,
            queueWorkflow,
            registerNodeMap: (nm) => { nodeMapRef.current = nm; },
            startExecution,
            finishExecution,
            cancelExecution,
            clearOutputs,
        }}>
            {children}
        </ComfyExecutionContext.Provider>
    );
};
