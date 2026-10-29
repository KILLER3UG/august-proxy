/* Session title/id/dedupe helpers. They never WRITE to the store — but two of
 * them read localStorage (`sessionIsEmpty` for transcript keys,
 * `pruneGhostSessions` for composer drafts), because "is this row empty" and
 * "does it hold unsent words" are questions about the cached keys, not the row. */

import type { Session } from './types';
import {
  clearComposerDraft,
  legacyMessagesStorageKey,
  loadComposerDraft,
  messagesStorageKey,
} from '@/sections/chat/message-storage';

/** Human-readable session id with local date/time, e.g.
 *  session_20260715_143052_a1b2. Legacy sessions keep their `sess_*` ids —
 *  prefix checks must accept BOTH (see isUiSessionId). */
export function makeSessionId(prefix = 'session'): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${stamp}_${rand}`;
}

/** True for a locally-created chat-session id. Accepts the new `session_*`
 *  scheme AND the legacy `sess_*` scheme (existing sessions keep their ids —
 *  localStorage keys, persisted transcripts, and the id↔workbench map all
 *  key off them). */
export function isUiSessionId(id: string | null | undefined): boolean {
  if (!id) return false;
  return id.startsWith('session_') || id.startsWith('sess_');
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
 * Immediate sidebar title from the first real user message.
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
  const aIsLocal = isUiSessionId(a.id);
  const bIsLocal = isUiSessionId(b.id);
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
    backgroundWork: primary.backgroundWork ?? secondary.backgroundWork,
    startedAt: primary.startedAt || secondary.startedAt,
    // Last activity is a high-water mark, not a "primary wins" field: the
    // sidebar's live ordering reads it, and a merge that kept the older stamp
    // would put a busy chat back where it was before it moved.
    updatedAt: newerStamp(primary.updatedAt, secondary.updatedAt),
    isArchived: !!(primary.isArchived || secondary.isArchived),
  };
}

/** The later of two ISO stamps; undefined when neither parses. */
function newerStamp(a: string | undefined, b: string | undefined): string | undefined {
  const ta = Date.parse(a || '');
  const tb = Date.parse(b || '');
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b : (a ?? b);
  if (!Number.isFinite(tb)) return a;
  return tb > ta ? b : a;
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
  // Index existing rows by their id and workbenchSessionId so the
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

  const kept = order.map((k) => byKey.get(k)!).filter(Boolean);
  /* Collapsing a row leaves its composer-draft key behind, and this function has
   * five callers — the SSE bridge (twice), the 60s reconcile, the launch heal and
   * the metadata merge. `store/sessions.ts` cleared the residue in two of them,
   * which is the same rule enforced two-fifths of the time: a blank draft under a
   * dropped id survived in storage forever and, because the sweep keeps any row
   * whose draft is non-blank, a later `persistComposerDraft` of real text under
   * that same key would resurrect a ghost row. Clearing here, once, is the
   * difference between a rule and a habit.
   *
   * Words are never deleted: `clearBlankDrafts` drops only a blank/whitespace
   * draft, and skips any key a surviving row still answers to. */
  clearBlankDrafts(sessions, kept);
  return kept;
}

/** Blank-only draft cleanup for the rows a collapse dropped, BOTH key forms.
 *
 *  The blank check IS the protection. A dropped row's workbench handle is usually
 *  the SURVIVING row's handle by then — that is precisely what the merge did — so
 *  skipping on that identity would leave every residue key behind, which is what
 *  an earlier comment claimed this code did and it never did. One non-blank draft
 *  under either key and neither is touched.
 */
export function clearBlankDrafts(dropped: Session[], kept: Session[]): void {
  const byId = new Set(kept.map((s) => s.id));
  for (const s of dropped) {
    if (byId.has(s.id)) continue;
    const keys = [s.id, s.workbenchSessionId].filter((k): k is string => !!k);
    if (keys.some((k) => loadComposerDraft(k).trim())) continue;
    for (const k of keys) clearComposerDraft(k);
  }
}

/** True when the session has no real conversation content yet. */export function sessionIsEmpty(s: Session): boolean {
  if (s.isArchived) return false;
  if ((s.messageCount ?? 0) > 0) return false;
  for (const id of [s.id, s.workbenchSessionId].filter(Boolean) as string[]) {
    try {
      /* The v2 key first, then the pre-v2 one. Reading only v2 makes every
       * session look empty between the upgrade and the user opening that chat
       * once — and `findReusableEmptySession` would then hand a REAL
       * conversation to "New chat", bump its startedAt and drop the user into a
       * chat they did not ask for. The v1 key is not read for content (that
       * goes through `loadMessagesForSession`, which merges and repairs it); it
       * is read here only as a "this session is not empty" signal.
       *
       * The v1 fallback must survive a v2 key holding an EMPTY ARRAY, not just
       * an absent one. `getItem(v2) ?? getItem(v1)` short-circuits on `"[]"`,
       * which `persistMessages` writes for a genuinely empty transcript — so the
       * protection re-enabled itself the moment the first empty fetch landed. */
      const candidates = [
        localStorage.getItem(messagesStorageKey(id)!),
        localStorage.getItem(legacyMessagesStorageKey(id)!),
      ];
      const nonEmpty = candidates.some((raw) => {
        if (!raw) return false;
        const msgs = JSON.parse(raw) as Array<{ role?: string }>;
        return (
          Array.isArray(msgs) &&
          msgs.some((m) => m?.role === 'user' || m?.role === 'assistant')
        );
      });
      if (nonEmpty) return false;
    } catch {
      /* ignore corrupt storage */
    }
  }
  return true;
}

/** One launch-time sweep: drop the ghost "New chat" rows the pre-fix reuse
 *  loop stacked on top of real history (17 measured on the live profile —
 *  every "+ New chat" press re-stamped an EMPTY row to the top of the list).
 *
 *  `startedAt` is no longer re-stamped (sessions.ts), so no NEW ghosts appear;
 *  this removes the residue. It is deliberately narrow — every condition must
 *  hold, and any doubt keeps the row:
 *  - placeholder title only ("New chat" / "New Session" / "Chat 2026-…"),
 *  - empty by `sessionIsEmpty` (messageCount AND both storage key
 *    generations, so a legacy-key transcript can never be swept as a ghost),
 *  - no unsent composer draft — typed-but-never-sent text is the one thing a
 *    ghost row can hold that no transcript key shows, and the sweep deletes
 *    the drafts of the rows it removes. A row carrying words is a row someone
 *    meant to finish, so it is kept and its draft survives with it.
 *  - no workbench link (a linked row is server-backed even when it looks
 *    empty — reconcile owns it),
 *  - not archived, not in a folder,
 *  - older than 24h, so the reuse pool `findReusableEmptySession` maintains
 *    (a deliberate fresh blank per scope) is never swept out from under it.
 *  An unparseable `startedAt` keeps the row: unprovable age, no deletion. */
export function pruneGhostSessions(
  sessions: Session[],
  opts: { now: number; maxAgeMs?: number },
): { kept: Session[]; removed: Session[] } {
  const maxAgeMs = opts.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const kept: Session[] = [];
  const removed: Session[] = [];
  for (const s of sessions) {
    if (
      !s.isArchived &&
      !s.folderId &&
      !s.workbenchSessionId &&
      isPlaceholderTitle(s.title) &&
      sessionIsEmpty(s) &&
      /* Whitespace-only counts as no draft: `persistComposerDraft` writes the
       * raw string, so a row whose composer holds "\n" is blank. Keyed on
       * `s.id`, exactly the key the store's sweep clears. */
      !loadComposerDraft(s.id).trim()
    ) {
      const started = Date.parse(s.startedAt || '');
      if (Number.isFinite(started) && opts.now - started > maxAgeMs) {
        removed.push(s);
        continue;
      }
    }
    kept.push(s);
  }
  return { kept, removed };
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
