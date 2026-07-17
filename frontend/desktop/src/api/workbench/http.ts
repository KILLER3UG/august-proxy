/* ── Workbench HTTP primitives ────────────────────────────────────────── */

export class WorkbenchHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'WorkbenchHttpError';
  }
}

export async function wbFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const msg =
      (body && typeof body === 'object' && 'message' in body
        ? String((body as { message?: string }).message)
        : null) ||
      (body && typeof body === 'object' && 'detail' in body
        ? String((body as { detail?: string }).detail)
        : null) ||
      `Request failed: ${res.status}`;
    throw new WorkbenchHttpError(msg, res.status, body);
  }
  if (res.status === 204) return undefined as T;
  // Prefer text() so empty DELETE bodies don't call json(); fall back for
  // partial Response mocks in unit tests that only stub json().
  if (typeof res.text === 'function') {
    const text = await res.text();
    if (!text.trim()) return undefined as T;
    return JSON.parse(text) as T;
  }
  if (typeof res.json === 'function') {
    return (await res.json()) as T;
  }
  return undefined as T;
}

export function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}
