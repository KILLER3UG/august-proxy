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

async function initBaseUrl(): Promise<void> {
  try {
    if (isTauri) {
      // Retry with backoff — first-launch bootstrap (venv + wheels) can take
      // well over the old ~11s window before /api/health answers.
      for (let i = 0; i < 40; i++) {
        const status: string = await invoke<string>('proxy_status');
        if (status.startsWith('ok:')) {
          baseUrl = `http://127.0.0.1:${status.split(':')[1]}`;
          installFetchPatch();
          return;
        }
        // Linear backoff capped: 250ms → 1.5s — ~45s total
        await new Promise((r) => setTimeout(r, Math.min(250 * (i + 1), 1500)));
      }
      // Last resort: assume the default port so raw `/api` calls don't hit HTML.
      baseUrl = 'http://127.0.0.1:8085';
      installFetchPatch();
    }
  } catch {
    /* not in Tauri production mode — Vite / same-origin proxy handles routing */
  }
}

const ready = initBaseUrl();

/** Await by modules that make raw fetch calls (e.g. gateway health poll). */
export async function whenReady(): Promise<string | null> {
  await ready;
  return baseUrl;
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
      const data = (await res.json()) as { error?: { code?: string; message?: string } };
      code = data?.error?.code ?? code;
      message = data?.error?.message ?? message;
    } catch {
      /* keep defaults */
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
