/* ── API client (Phase 1.5) ─────────────────────────────────────────── */
/* Same-origin fetch wrapper. The proxy serves both UI and API. */

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/lib/tauri-detect';

let baseUrl: string | null = null;

async function initBaseUrl(): Promise<void> {
  try {
    if (isTauri) {
      // Retry with backoff in case the Node backend hasn't finished starting yet.
      // The backend starts the HTTP listener in the same tick, but the Tauri
      // WebView can load the SPA before the health check succeeds.
      for (let i = 0; i < 6; i++) {
        const status: string = await invoke<string>('proxy_status');
        if (status.startsWith('ok:')) {
          baseUrl = `http://127.0.0.1:${status.split(':')[1]}`;
          return;
        }
        // Linear backoff: 200ms, 400ms, 600ms, … — ~4.2 s total before giving up
        await new Promise(r => setTimeout(r, 200 * (i + 1)));
      }
    }
  } catch { /* not in Tauri production mode — dev proxy handles routing */ }
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
    } catch { /* keep defaults */ }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get:    <T>(path: string)                 => request<T>(path),
  post:   <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST',   body: body !== undefined ? JSON.stringify(body) : undefined }),
  put:    <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT',    body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch:  <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH',  body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string)                 => request<T>(path, { method: 'DELETE' }),
};
