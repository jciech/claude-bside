// Fetch with retries for transient failures (network errors, 408/429/5xx). superdough and the
// soundfont loader cache a failed load forever, so the engine fetches through here first.
const DELAYS_MS = [600, 2000, 5000];

const retryable = (status: number): boolean => status === 408 || status === 429 || status >= 500;

export async function fetchWithRetry(url: string, init?: RequestInit, delays: readonly number[] = DELAYS_MS): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status} for ${url}`);
      if (!retryable(res.status)) break;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not fetch ${url}`);
}
