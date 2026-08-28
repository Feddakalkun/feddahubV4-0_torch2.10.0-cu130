import { BACKEND_API } from '../config/api';

/**
 * Stop the running job and drop anything queued behind it.
 *
 * Prefers the backend, which knows COMFY_URL and can cancel in deployments
 * where the browser cannot reach ComfyUI at all. Falls back to talking to
 * ComfyUI through the /comfy proxy when that endpoint is missing — an older
 * backend that has not been restarted since /api/generate/cancel was added
 * would otherwise leave the Cancel button doing nothing at all.
 *
 * Both paths do the same two things, because they are different: /interrupt
 * kills the sampler mid-step for the job already executing, while a queued job
 * has not started and can only be removed from the pending list.
 */
export async function cancelGeneration(promptId?: string | null): Promise<boolean> {
  const query = promptId ? `?prompt_id=${encodeURIComponent(promptId)}` : '';
  try {
    const resp = await fetch(`${BACKEND_API.BASE_URL}/api/generate/cancel${query}`, { method: 'POST' });
    if (resp.ok) return true;
  } catch {
    // Backend unreachable — try ComfyUI directly below.
  }

  try {
    await fetch('/comfy/interrupt', { method: 'POST' });
    await fetch('/comfy/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(promptId ? { delete: [promptId] } : { clear: true }),
    });
    return true;
  } catch {
    return false;
  }
}
