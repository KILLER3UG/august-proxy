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

/**
 * Creation title: a neutral "New chat" placeholder (M7 item 4). Timestamps as
 * names are gone — the first user message renames this immediately (snippet
 * title) and the LLM titler upgrades it after the first reply. The old
 * date-stamped format is still matched by isPlaceholderTitle so existing
 * sessions keep auto-titling.
 */
export function defaultSessionTitle(): string {
  return 'New chat';
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

/**
 * Immediate sidebar title from the first real user message (plan §5.2).
 * Client mirror of the backend's `derive_title_from_message` — the snippet
 * title shows at send time; the backend LLM titler treats it as a soft
 * fallback and refines it after the first reply when the provider allows.
 * Returns '' for slash commands or too-short text (no title derived).
 */
export function deriveSnippetTitle(text: string, maxLen = 48): string {
  let cleaned = (text || '').replace(/\r\n/g, '\n').trim();
  if (!cleaned) return '';
  // Strip accidental role-prefixed dumps ("user: …").
  cleaned = cleaned.replace(/^(user|assistant|system)\s*:\s*/i, '');
  let first = cleaned.split('\n', 1)[0].trim();
  first = first.split(/\s+(?:user|assistant|system)\s*:\s*/i)[0].trim();
  first = first.replace(/\s+/g, ' ').trim();
  if (/^\/[a-zA-Z]/.test(first)) return '';
  if (first.length < 2) return '';
  if (first.length > maxLen) first = first.slice(0, maxLen).trimEnd() + '…';
  return first;
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
  // Part 27 T5: index existing rows by their id and workbenchSessionId so the
  // cross-link is O(1) per session instead of an O(n) scan of every prior row
  // (this ran on every realtime session event + the 60s reconcile).
  const byId = new Map<string, string>(); // session.id -> byKey key
  const byWb = new Map<string, string>(); // session.workbenchSessionId -> byKey key

  const keyFor = (s: Session): string => {
    if (s.workbenchSessionId) return `wb:${s.workbenchSessionId}`;
    if (s.id.startsWith('wb_')) return `wb:${s.id}`;
    return `id:${s.id}`;
  };

  const indexRow = (key: string, s: Session) => {
    if (s.id) byId.set(s.id, key);
    if (s.workbenchSessionId) byWb.set(s.workbenchSessionId, key);
  };

  for (const s of sessions) {
    const key = keyFor(s);
    const existing = byKey.get(key);
    if (existing) {
      const merged = preferSessionRow(existing, s);
      byKey.set(key, merged);
      indexRow(key, merged);
      continue;
    }

    // Cross-link: an existing row may share this session's id or workbench id
    // under a different key (e.g. id:sess_* later gains the same workbench as
    // a wb:X row). The four lookups cover every equality the old scan tested.
    const candidates = [
      s.id ? byId.get(s.id) : undefined,
      s.workbenchSessionId ? byId.get(s.workbenchSessionId) : undefined,
      s.id ? byWb.get(s.id) : undefined,
      s.workbenchSessionId ? byWb.get(s.workbenchSessionId) : undefined,
    ];
    let mergedInto: string | null = null;
    for (const ek of candidates) {
      if (ek && byKey.has(ek)) {
        const es = byKey.get(ek)!;
        const merged = preferSessionRow(es, s);
        byKey.set(ek, merged);
        indexRow(ek, merged);
        mergedInto = ek;
        break;
      }
    }
    if (mergedInto) continue;

    byKey.set(key, s);
    indexRow(key, s);
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

/**
 * Normalise a filesystem path for consistent comparison.
 * Replaces backslashes with forward slashes and strips trailing slashes.
 */
export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, '/').replace(/\/+$/, '');
  // Stable Windows drive letter (C: vs c:) so folder matching does not fork.
  if (/^[a-zA-Z]:\//.test(p)) {
    p = p[0].toUpperCase() + p.slice(1);
  }
  return p;
}

/** Path equality for workspace/folder matching (case-insensitive on Windows). */
export function pathsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (na === nb) return true;
  // Windows paths are case-insensitive; treat the same elsewhere for safety
  // when drive letters / mixed casing show up from different APIs.
  return na.toLowerCase() === nb.toLowerCase();
}

/**
 * Derive a human‑readable folder name from a filesystem path.
 */
export function folderNameFromPath(path: string): string {
  const normalized = normalizePath(path);
  const segments = normalized.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : 'workspace';
}
