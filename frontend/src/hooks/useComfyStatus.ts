// Hook for checking ComfyUI connection status
import { useState, useEffect } from 'react';
import { comfyService } from '../services/comfyService';

export const useComfyStatus = (pollInterval: number = 3000) => {
    const [isConnected, setIsConnected] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let intervalId: ReturnType<typeof setInterval>;

        const checkStatus = async () => {
            try {
                // Keep this aligned with the top system strip so status indicators agree.
                // Primary check via local Vite proxy route to ComfyUI.
                let alive = false;
                try {
                    const proxied = await fetch('/comfy/system_stats', { cache: 'no-store' });
                    alive = proxied.ok;
                } catch {
                    alive = false;
                }

                // Fallback to service probe (covers runpod/direct modes).
                if (!alive) {
                    alive = await comfyService.isAlive();
                }
                setIsConnected(alive);
            } catch (error) {
                setIsConnected(false);
            } finally {
                setIsLoading(false);
            }
        };

        // Check immediately
        checkStatus();

        // Then poll at interval
        intervalId = setInterval(checkStatus, pollInterval);

        return () => {
            if (intervalId) clearInterval(intervalId);
        };
    }, [pollInterval]);

    return { isConnected, isLoading };
};

