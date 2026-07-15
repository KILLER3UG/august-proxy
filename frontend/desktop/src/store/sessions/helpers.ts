/* Pure session title/id/dedupe helpers with no store side effects. */

import type { Session } from './types';

/** Human-readable session id with local date/time, e.g. sess_20260715_143052_a1b2 */
export function makeSessionId(prefix = 'sess'): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${stamp}_${rand}`;
}

/** Default title stamped with local date/time until the first user message. */
export function defaultSessionTitle(when: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  return `Chat ${stamp}`;
}

/** True when the title is still a default/empty placeholder. */
export function isPlaceholderTitle(title: string | null | undefined): boolean {
  const t = (title || '').trim();
  if (!t) return true;
  if (/^(new chat|new session|untitled|conversation started\.?)$/i.test(t)) return true;
  // Date-stamped defaults: "Chat 2026-07-15 14:30" / "Chat 2026-07-15 14:30 UTC"
  if (/^chat\s+\d{4}-\d{2}-\d{2}/i.test(t)) return true;
  return false;
}

/** Prefer a real title over a placeholder when merging local + backend. */
export function preferSessionTitle(
  preferred: string | null | undefined,
  fallback: string | null | undefined,
): string {
  if (preferred && !isPlaceholderTitle(preferred)) return preferred.trim();
  if (fallback && !isPlaceholderTitle(fallback)) return fallback.trim();
  return (preferred || fallback || defaultSessionTitle()).trim();
}

/**
 * Prefer the better of two session rows that share the same workbench id
 * (or are otherwise duplicates). Keeps a stable local `sess_*` UI id when
 * present so the URL / ChatThread mount does not thrash.
 */
export function preferSessionRow(a: Session, b: Session): Session {
  // Prefer stable frontend id over raw workbench id as the row key.
  const aIsLocal = a.id.startsWith('sess_');
  const bIsLocal = b.id.startsWith('sess_');
  const primary = aIsLocal && !bIsLocal ? a : bIsLocal && !aIsLocal ? b : a;
  const secondary = primary === a ? b : a;
  const stableId = aIsLocal ? a.id : bIsLocal ? b.id : primary.id;
  return {
    ...secondary,
    ...primary,
    id: stableId,
    workbenchSessionId:
      primary.workbenchSessionId ||
      secondary.workbenchSessionId ||
      (primary.id.startsWith('wb_') ? primary.id : undefined) ||
      (secondary.id.startsWith('wb_') ? secondary.id : undefined),
    title: preferSessionTitle(primary.title, secondary.title),
    messageCount: Math.max(primary.messageCount ?? 0, secondary.messageCount ?? 0),
    lastMessage: primary.lastMessage || secondary.lastMessage,
    provider: primary.provider || secondary.provider,
    model: primary.model || secondary.model,
    folderId: primary.folderId ?? secondary.folderId,
    workspacePath: primary.workspacePath ?? secondary.workspacePath,
    workbenchAgentId: primary.workbenchAgentId || secondary.workbenchAgentId,
    workbenchProvider: primary.workbenchProvider || secondary.workbenchProvider,
    startedAt: primary.startedAt || secondary.startedAt,
    isArchived: !!(primary.isArchived || secondary.isArchived),
  };
}

/**
 * Collapse duplicate sidebar rows that share a workbenchSessionId (or where
 * one row's id is another's workbenchSessionId). Fixes races where SSE
 * `session.created` inserts a `wb_*` row while ChatThread still holds `sess_*`.
 */
export function dedupeSessions(sessions: Session[]): Session[] {
  if (sessions.length <= 1) return sessions;

  const byKey = new Map<string, Session>();
  const order: string[] = [];

  const keyFor = (s: Session): string => {
    if (s.workbenchSessionId) return `wb:${s.workbenchSessionId}`;
    if (s.id.startsWith('wb_')) return `wb:${s.id}`;
    return `id:${s.id}`;
  };

  for (const s of sessions) {
    const key = keyFor(s);
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, preferSessionRow(existing, s));
      continue;
    }

    // Cross-link: e.g. existing id:sess_* later gains same workbench as wb:X row
    let mergedInto: string | null = null;
    for (const [ek, es] of byKey) {
      const same =
        es.id === s.id ||
        es.workbenchSessionId === s.id ||
        s.workbenchSessionId === es.id ||
        (!!es.workbenchSessionId &&
          !!s.workbenchSessionId &&
          es.workbenchSessionId === s.workbenchSessionId) ||
        (es.id.startsWith('wb_') && s.workbenchSessionId === es.id) ||
        (s.id.startsWith('wb_') && es.workbenchSessionId === s.id);
      if (same) {
        byKey.set(ek, preferSessionRow(es, s));
        mergedInto = ek;
        break;
      }
    }
    if (mergedInto) continue;

    byKey.set(key, s);
    order.push(key);
  }

  return order.map((k) => byKey.get(k)!).filter(Boolean);
}

/** True when the session has no real conversation content yet. */
export function sessionIsEmpty(s: Session): boolean {
  if (s.isArchived) return false;
  if ((s.messageCount ?? 0) > 0) return false;
  for (const id of [s.id, s.workbenchSessionId].filter(Boolean) as string[]) {
    try {
      const raw = localStorage.getItem(`chat_messages_${id}`);
      if (!raw) continue;
      const msgs = JSON.parse(raw) as Array<{ role?: string }>;
      if (
        Array.isArray(msgs) &&
        msgs.some((m) => m?.role === 'user' || m?.role === 'assistant')
      ) {
        return false;
      }
    } catch {
      /* ignore corrupt storage */
    }
  }
  return true;
}

/** Short sidebar title from the first user message (not a raw dump). */
export function deriveSessionTitleFromMessage(text: string): string | null {
  let cleaned = (text || '').replace(/\r\n/g, '\n').trim();
  if (!cleaned) return null;
  // Drop accidental role-prefixed transcript dumps saved as a single "user" blob.
  cleaned = cleaned.replace(/^(user|assistant|system)\s*:\s*/i, '');
  // Prefer the first meaningful line / sentence.
  const firstChunk = cleaned.split(/\n+/)[0] || cleaned;
  cleaned = firstChunk.replace(/\s+/g, ' ').trim();
  // If it still looks like a multi-turn transcript, take text before the next role marker.
  cleaned = cleaned.split(/\s+(?:user|assistant|system)\s*:\s*/i)[0]?.trim() || cleaned;
  if (cleaned.length < 2) return null;
  if (cleaned.length > 48) cleaned = `${cleaned.slice(0, 48).trim()}…`;
  return cleaned;
}

/**
 * Normalise a filesystem path for consistent comparison.
 * Replaces backslashes with forward slashes and strips trailing slashes.
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Derive a human‑readable folder name from a filesystem path.
 */
export function folderNameFromPath(path: string): string {
  const normalized = normalizePath(path);
  const segments = normalized.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : 'workspace';
}
