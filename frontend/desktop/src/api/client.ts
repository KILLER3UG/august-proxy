/* ── API client (Phase 1.5) ─────────────────────────────────────────── */
/* Same-origin fetch wrapper. The proxy serves both UI and API. */

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/lib/tauri-detect';

let baseUrl: string | null = null;
let fetchPatched = false;

/**
 * The per-install token the backend's sensitive local routes require.
 *
 * `/api/*` is the local SPA's surface and has no authentication by design —
 * but "local" is "any process on this machine", and so is a model with
 * `run_command` that can reach loopback. The routes that start subagent
 * workers and approve harness proposals therefore need a credential.
 *
 * The desktop shell generates the token and hands it to the webview over the
 * Tauri IPC, which is the ONLY channel to it that another local process
 * cannot use. It is not on disk: a file in the data directory would be
 * readable by the very model this is meant to stop.
 *
 * A Tauri-LESS host has no IPC to ask, so the token travels with the page
 * instead: in the URL fragment, in the query string, or in a global the host
 * sets before boot. See `LOCAL_TOKEN_URL_PARAM` below. The token still never
 * touches the disk from here — it lives in ONE module-level variable,
 * `resolvedLocalToken`, for the lifetime of the page, and nowhere else.
 */
let resolvedLocalToken: string | null = null;
let localTokenPromise: Promise<string | null> | null = null;

/** The parameter name the token travels under in a pairing URL. */
export const LOCAL_TOKEN_URL_PARAM = 'august-token';

/**
 * A host page may set this global before the app boots. The mobile shell
 * does exactly that, and it is the only path where the token never touches
 * a URL at all.
 */
function hostGlobalToken(): string | null {
  if (typeof window === 'undefined') return null;
  const value = (window as Window & { __AUGUST_LOCAL_TOKEN__?: string }).__AUGUST_LOCAL_TOKEN__;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Build the pairing URL a phone opens: the app's URL with the token in the
 * FRAGMENT.
 *
 * A fragment is never sent to the server and never appears in a `Referer`
 * header, so a token in the fragment cannot reach an access log the way the
 * same token in a query parameter would. The web client reads it and takes
 * it back out of the URL (see `captureTokenFromUrl`).
 */
export function buildPairingUrl(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/#${LOCAL_TOKEN_URL_PARAM}=${encodeURIComponent(token)}`;
}

/**
 * Remove the token from the visible URL and from the history entry.
 *
 * `history.replaceState` REWRITES the current entry instead of pushing a
 * new one, so the entry that recorded the token is replaced rather than
 * merely hidden one back-button away — a history walk would otherwise find
 * it. A fragment that is a route (`#/settings/x`, no `=`) is left exactly
 * as it is; only a fragment that actually carries the token is rebuilt.
 */
function stripTokenFromUrl(): void {
  if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') return;
  const loc = window.location;
  let search = loc.search;
  let hash = loc.hash;

  if (new RegExp(`(?:^|[?&])${LOCAL_TOKEN_URL_PARAM}=`).test(search)) {
    const params = new URLSearchParams(search);
    params.delete(LOCAL_TOKEN_URL_PARAM);
    const rest = params.toString();
    search = rest ? `?${rest}` : '';
  }

  if (hash) {
    const parts = hash.slice(1).split('&');
    if (parts.some((p) => p.startsWith(`${LOCAL_TOKEN_URL_PARAM}=`))) {
      const kept = parts.filter((p) => !p.startsWith(`${LOCAL_TOKEN_URL_PARAM}=`));
      hash = kept.length ? `#${kept.join('&')}` : '';
    }
  }

  const next = `${loc.pathname}${search}${hash}`;
  if (next === `${loc.pathname}${loc.search}${loc.hash}`) return;
  try {
    window.history.replaceState(window.history.state, '', next);
  } catch {
    /* a sandboxed frame may refuse replaceState — the token still leaves
       the request path, and the in-memory copy is what the app uses. */
  }
}

/**
 * Take the token out of the URL and hand it back.
 *
 * Called ONCE at module load — before React renders — because the token
 * must not survive in the address bar, in the browser history, or in a
 * screenshot of the window. Stripping it here is also what keeps it out
 * of a `Referer` to a third-party host: the first paint has already
 * replaced the entry.
 */
function captureTokenFromUrl(): string | null {
  if (typeof window === 'undefined' || !window.location) return null;
  const loc = window.location;
  let raw: string | null = null;

  // Fragment first: it is the form the pairing surface prints, and it is
  // the only form the server never sees.
  const fragment = loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash;
  if (fragment) {
    const match = new RegExp(`(?:^|&)${LOCAL_TOKEN_URL_PARAM}=([^&]*)`).exec(fragment);
    if (match) raw = match[1];
  }
  // Query fallback, for a host that cannot set a fragment.
  if (raw === null) {
    const match = new RegExp(`(?:^|[?&])${LOCAL_TOKEN_URL_PARAM}=([^&#]*)`).exec(loc.search);
    if (match) raw = match[1];
  }
  if (raw === null) return null;

  let token = raw;
  try {
    token = decodeURIComponent(raw);
  } catch {
    /* a malformed escape is used as-is */
  }
  stripTokenFromUrl();
  return token.trim() || null;
}

/**
 * The token a Tauri-less host handed us in the URL, captured and stripped
 * at module load. `null` when the page was not opened through a pairing
 * URL — which is the ordinary case, and the case where the backend has no
 * token configured and the gate is a no-op.
 */
const bootHostToken: string | null = captureTokenFromUrl();

function localToken(): Promise<string | null> {
  if (resolvedLocalToken) return Promise.resolve(resolvedLocalToken);
  // Outside Tauri there is no IPC to ask, and both host-supplied sources
  // are synchronous reads — so there is nothing to await and no in-flight
  // promise to keep. Re-read on every call until one is found, so a host
  // that sets the global late still works.
  if (!isTauri) {
    const hostToken = bootHostToken ?? hostGlobalToken();
    if (hostToken) resolvedLocalToken = hostToken;
    return Promise.resolve(resolvedLocalToken);
  }
  if (!localTokenPromise) {
    localTokenPromise = (async (): Promise<string | null> => {
      try {
        const token = await invoke<string>('local_api_token');
        if (token) resolvedLocalToken = token;
        return token || null;
      } catch {
        // The command is missing in an older shell build. Leave the token
        // unset and retry on the next call rather than caching the failure.
        return null;
      } finally {
        localTokenPromise = null;
      }
    })();
  }
  return localTokenPromise;
}

/**
 * The per-install token this client will send, or null when there is none.
 *
 * Exported for the phone-pairing surface, which is the ONE place that
 * shows the token to a human. Outside Tauri it is the token the host page
 * supplied (URL fragment, query string, or `window.__AUGUST_LOCAL_TOKEN__`);
 * inside Tauri it is the shell's, over the IPC.
 */
export function getLocalToken(): Promise<string | null> {
  return localToken();
}

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

/** Attempts per discovery run, and the settled promise for the current one.
 *
 *  `DISCOVERY_ATTEMPTS` is a mutable binding rather than a frozen constant so
 *  tests can shrink the retry budget; production never reassigns it. */
export let DISCOVERY_ATTEMPTS = 120;

/** Per-attempt backoff ceiling, in ms. Linear ramp: 250ms → this. */
export let DISCOVERY_MAX_BACKOFF_MS = 1500;

/** Test-only: shrink the retry budget so a failing-discovery test does not
 *  spend real wall-clock on the backoff ramp. Not called in production. */
export function setDiscoveryBudget(attempts: number, maxBackoffMs = 1500): void {
  DISCOVERY_ATTEMPTS = Math.max(1, Math.floor(attempts));
  DISCOVERY_MAX_BACKOFF_MS = Math.max(0, Math.floor(maxBackoffMs));
}

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
    await new Promise((r) => setTimeout(r, Math.min(250 * (i + 1), DISCOVERY_MAX_BACKOFF_MS)));
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

/** Await by modules that make raw fetch calls (e.g. gateway health poll).
 *
 *  Calls `ensureReady()` on EVERY await rather than closing over one promise.
 *  The first version captured `const ready = ensureReady()` at module scope,
 *  which made `resetDiscovery` a no-op for every consumer: nulling
 *  `readyPromise` did nothing because `whenReady` still awaited the original,
 *  already-rejected promise — so the recovery path was unreachable in
 *  production, not just untested. Reading the current binding each time is
 *  what makes the reset real. */
export async function whenReady(): Promise<string | null> {
  await ensureReady();
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

/** True for a host that resolves to THIS machine. */
function isLoopbackHost(url: string): boolean {
  let hostname = url;
  try {
    hostname = new URL(url).hostname;
  } catch {
    /* not a URL — fall back to the raw string */
  }
  const host = hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/**
 * WebSocket URL for the backend. Mirrors `apiUrl` but swaps the scheme to
 * ws/wss — and in Tauri targets `ws://127.0.0.1:<port>`, which is the only
 * ws origin the desktop CSP (`connect-src … ws://127.0.0.1:*`) permits.
 *
 * THE TOKEN RIDES IN THE QUERY STRING when the backend is NOT on
 * loopback. A browser WebSocket handshake cannot set custom headers, and
 * in LAN mode the backend requires the per-install token on every
 * management route — the socket routes included
 * (`require_lan_token` in backend-py/app/lib/local_api_auth.py). A query
 * parameter is the only channel a browser socket has, and it does not
 * reach a log: uvicorn's access logger is silenced
 * (`app/lib/logging_config.py` sets `uvicorn.access` to WARNING) and
 * nothing else logs a request's query string.
 *
 * On loopback the token is left off: the backend exempts a loopback peer
 * (`_is_loopback_peer`), and the desktop's own sockets should not put a
 * secret in a URL they do not need it in.
 */
export async function wsUrl(path: string): Promise<string> {
  const base = await whenReady();
  const url = base
    ? `${base.replace(/^http/, 'ws')}${path}`
    : `${typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${path}`;
  if (isLoopbackHost(url)) {
    return url;
  }
  const token = await localToken();
  if (!token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${LOCAL_TOKEN_URL_PARAM}=${encodeURIComponent(token)}`;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  await ensureReady();
  const url = baseUrl ? `${baseUrl}${path}` : path;
  const token = await localToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-August-Local-Token': token } : {}),
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
 *  sets the multipart boundary), unlike `api.post` which JSON-encodes.
 *  Carries the same local token as `request` — the gate is the gate, and a
 *  route that ever moves behind it must not find a second, tokenless
 *  transport in the same client. */
async function requestRaw<T>(path: string, body: BodyInit, init?: RequestInit): Promise<T> {
  await ensureReady();
  const url = baseUrl ? `${baseUrl}${path}` : path;
  const token = await localToken();
  const res = await fetch(url, {
    ...init,
    body,
    headers: {
      ...(token ? { 'X-August-Local-Token': token } : {}),
      ...(init?.headers ?? {}),
    },
  });
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
