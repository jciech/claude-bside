// HTTP and server-sent events for /api/composer/* (routes and shapes: src/shared/composer-api.ts).
import type { Issue } from '../shared/analysis.ts';

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly issues: Issue[];
  constructor(status: number, message: string, issues: Issue[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  /** Streams events until the server closes the stream or `signal` aborts. */
  events(signal: AbortSignal, onEvent: (event: string, data: unknown) => void): Promise<void>;
}

const HINTS: Record<number, string> = {
  401: 'set BSIDE_ADMIN_TOKEN (or --token) to the server\'s admin token',
  403: 'the server refused this client: without a token only loopback connections are allowed in development',
  404: 'the composer API is disabled (production without BSIDE_ADMIN_TOKEN) or this is not a B-Side server',
  429: 'rate limited; wait a moment',
};

export function createApiClient(opts: { baseUrl: string; token?: string | null; fetch?: typeof fetch }): ApiClient {
  const doFetch = opts.fetch ?? fetch;
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/api/composer`;
  const headers = (extra: Record<string, string> = {}) => ({ ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...extra });

  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(0, `cannot reach ${opts.baseUrl}: ${(e as Error).message}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: reported below with the status
    }
    if (!res.ok) {
      const payload = (json ?? {}) as { error?: string; issues?: Issue[] };
      const hint = HINTS[res.status];
      throw new ApiError(res.status, `${res.status} ${payload.error ?? res.statusText}${hint ? ` (${hint})` : ''}`, payload.issues ?? []);
    }
    return json as T;
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),

    async events(signal, onEvent) {
      let res: Response;
      try {
        res = await doFetch(`${base}/events`, { headers: headers({ accept: 'text/event-stream' }), signal });
      } catch (e) {
        if (signal.aborted) return;
        throw new ApiError(0, `cannot reach ${opts.baseUrl}: ${(e as Error).message}`);
      }
      if (!res.ok || !res.body) throw new ApiError(res.status, `${res.status} ${res.statusText}${HINTS[res.status] ? ` (${HINTS[res.status]})` : ''}`);
      const decoder = new TextDecoder();
      let buffer = '';
      const dispatch = (block: string) => {
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
        }
        if (!data.length) return;
        const raw = data.join('\n');
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // keep the raw string
        }
        onEvent(event, parsed);
      };
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
          let at: number;
          while ((at = buffer.indexOf('\n\n')) >= 0) {
            dispatch(buffer.slice(0, at));
            buffer = buffer.slice(at + 2);
          }
        }
      } catch (e) {
        if (!signal.aborted) throw new ApiError(0, `event stream broke: ${(e as Error).message}`);
      }
    },
  };
}
