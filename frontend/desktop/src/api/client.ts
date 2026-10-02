/* ── API client (Phase 1.5) ─────────────────────────────────────────── */
/* Same-origin fetch wrapper. The proxy serves both UI and API. */

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/lib/tauri-detect';

let baseUrl: string | null = null;
let fetchPatched = false;

function rewriteApiUrl(url: string): string {
  if (!baseUrl) return url;
  if (url.startsWith('/api') || url.startsWith('/v1')) {
    return `${baseUrl}${url}`;
  }
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : baseUrl);
    if (
      typeof window !== 'undefined' &&
      parsed.origin === window.location.origin &&
      (parsed.pathname.startsWith('/api') || parsed.pathname.startsWith('/v1'))
    ) {
      return `${baseUrl}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    /* keep original */
  }
  return url;
}

/** In the Tauri webview, relative `/api` hits the asset origin (HTML), not
 *  the Python proxy. Rewrite those requests once we know the backend port. */
function installFetchPatch(): void {
  if (fetchPatched || typeof window === 'undefined' || !baseUrl) return;
  fetchPatched = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string') {
      return originalFetch(rewriteApiUrl(input), init);
    }
    if (input instanceof URL) {
      return originalFetch(rewriteApiUrl(input.toString()), init);
    }
    if (input instanceof Request) {
      const next = rewriteApiUrl(input.url);
      if (next !== input.url) {
        return originalFetch(new Request(next, input), init);
      }
    }
    return originalFetch(input, init);
  };
}

/** Attempts per discovery run, and the settled promise for the current one. */
const DISCOVERY_ATTEMPTS = 120;

/* Discovery must be RECOVERABLE.
 *
 * This used to be `const ready = initBaseUrl()` — one promise, one shot. A
 * first launch or post-update re-materialization slower than ~3 minutes (its
 * own overlay says "can take 1-2 minutes"; a cold AV scan or a slow disk blows
 * past it) rejected it FOREVER: `const` cannot be reassigned, so every
 * `await ready` in whenReady/apiUrl/wsUrl rejected from then on and
 * installFetchPatch never ran, meaning every relative /api fetch went to the
 * Tauri asset origin. Meanwhile BackendBootstrapGate polls `proxy_status` on
 * its own 1s interval and reveals the app anyway — so the user got a fully
 * mounted UI against a dead API layer, with restart as the only way out.
 *
 * A settled promise is now CACHED, and a failed run is DISCARDED so the next
 * caller retries discovery rather than inheriting a dead promise. */
let readyPromise: Promise<void> | null = null;
let resolvedBaseUrl: string | null = null;

async function discoverBaseUrl(): Promise<void> {
  // Browser/Vite mode uses the same-origin proxy: there is no supervisor to
  // poll and `invoke` does not exist. Resolve immediately (as `baseUrl` stays
  // null, so rewriteApiUrl is a pass-through).
  if (!isTauri) return;

  // Retry with backoff — first-launch bootstrap (venv + wheels) can take
  // well over the old ~11s window before /api/health answers. Never guess
  // 8085 here: the Rust supervisor may deliberately select 8086-8095 when
  // the default port is occupied, and a guessed URL silently targets the
  // wrong process (or the Vite asset origin).
  for (let i = 0; i < DISCOVERY_ATTEMPTS; i++) {
    try {
      const status: string = await invoke<string>('proxy_status');
      if (status.startsWith('ok:')) {
        resolvedBaseUrl = `http://127.0.0.1:${status.split(':')[1]}`;
        baseUrl = resolvedBaseUrl;
        installFetchPatch();
        return;
      }
    } catch {
      // The backend may be between process launches; keep polling.
    }
    // Linear backoff capped: 250ms → 1.5s — about three minutes worst case.
    await new Promise((r) => setTimeout(r, Math.min(250 * (i + 1), 1500)));
  }
  throw new Error('August backend did not become ready');
}

function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = discoverBaseUrl().catch((err) => {
      // Do not cache the failure: the next caller (a later mount, a retry, the
      // gate's own health poll resolving) must get a fresh attempt.
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

/** Discard a failed discovery so the next caller retries. Used by the bootstrap
 *  gate when it observes the proxy come up after discovery gave up. */
export function resetDiscovery(): void {
  readyPromise = null;
}

const ready = ensureReady();

/** Await by modules that make raw fetch calls (e.g. gateway health poll). */
export async function whenReady(): Promise<string | null> {
  await ready;
  return baseUrl;
}

/** Absolute backend URL for a non-fetch transport (EventSource) that bypasses
 *  the window.fetch rewrite. In Tauri, relative `/api` hits the asset origin,
 *  so resolve through the discovered proxy base; in web, keep it same-origin
 *  (the Vite proxy forwards it). */
export async function apiUrl(path: string): Promise<string> {
  const base = await whenReady();
  return base ? `${base}${path}` : path;
}

/** Synchronous backend base for transports that must build their URL without
 *  awaiting (EventSource/WebSocket opened in a render effect). Returns the
 *  discovered proxy base once ready, else null (web same-origin). Callers that
 *  run after the bootstrap gate always see the resolved base in Tauri. */
export function backendOriginSync(): string | null {
  return baseUrl;
}

/** WebSocket URL for the backend. Mirrors `apiUrl` but swaps the scheme to
 *  ws/wss — and in Tauri targets `ws://127.0.0.1:<port>`, which is the only
 *  ws origin the desktop CSP (`connect-src … ws://127.0.0.1:*`) permits. */
export async function wsUrl(path: string): Promise<string> {
  const base = await whenReady();
  if (base) return `${base.replace(/^http/, 'ws')}${path}`;
  const proto = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  await ready;
  const url = baseUrl ? `${baseUrl}${path}` : path;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let code = 'unknown';
    let message = res.statusText;
    try {
      const data = (await res.json()) as {
        error?: string | { code?: string; message?: string };
        detail?: string | { code?: string; message?: string };
      };
      const err = data?.error;
      if (typeof err === 'string') {
        // The backend 404 fallback returns { error: 'Not found', path }
        // (string, not object). Surface it instead of bare res.statusText.
        message = err;
      } else if (err && typeof err === 'object') {
        code = err.code ?? code;
        message = err.message ?? message;
      } else if (typeof data?.detail === 'string') {
        // FastAPI HTTPException(detail=...) shape.
        message = data.detail;
      } else if (data?.detail && typeof data.detail === 'object') {
        // FastAPI can also return { detail: { code, message } } — parsing
        // only the string form left code='unknown' and dropped the message,
        // which made e.g. the External Access toggle silently no-op.
        code = data.detail.code ?? code;
        message = data.detail.message ?? message;
      }
    } catch {
      /* keep defaults */
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Multipart / binary upload: passes `body` through untouched (the browser
 *  sets the multipart boundary), unlike `api.post` which JSON-encodes. */
async function requestRaw<T>(path: string, body: BodyInit, init?: RequestInit): Promise<T> {
  await ready;
  const url = baseUrl ? `${baseUrl}${path}` : path;
  const res = await fetch(url, { ...init, body });
  if (!res.ok) throw new ApiError(res.status, 'unknown', res.statusText);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>(path, init),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>, init?: RequestInit) =>
    request<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers,
      ...init,
    }),
  postRaw: <T>(path: string, body: BodyInit, init?: RequestInit) => requestRaw<T>(path, body, init),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown, init?: RequestInit) =>
    request<T>(path, {
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...init,
    }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
