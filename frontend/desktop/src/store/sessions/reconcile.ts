/* Merge local sidebar sessions with workbench SoT (`GET /api/workbench/sessions`). */

import { getWorkbenchSessions } from '@/api/workbench';
import { dedupeSessions, preferSessionTitle, sessionIsEmpty } from './helpers';
import { saveSessionsToStorage } from './storage';
import { isSessionIdTombstoned } from './tombstone';
import type { Session } from './types';

export type SessionsSnapshot = {
  getSessions: () => Session[];
  setSessions: (sessions: Session[]) => void;
};

/**
 * Reconcile chat sidebar sessions from the workbench session SoT only
 * (`GET /api/workbench/sessions`). Do not use `/api/sessions` for chat —
 * that plane is non-chat / manage-only.
 *
 * Match order: local.workbenchSessionId → local.id → backend id.
 * Frontend-only fields (lastMessage, folderId, …) are preserved on merge.
 *
 * Important:
 * - UI session `id` stays stable (`sess_*`). Never rewrite to the workbench id
 *   mid-flight — that invalidated the open `/c/sess_…` route and spawned a
 *   second session (or looked like the new chat was deleted).
 * - Local-only drafts (no workbenchSessionId yet) are kept even when the
 *   backend list is empty.
 * - Locals whose workbenchSessionId is gone from the backend are dropped
 *   (true server-side delete), unless tombstoned already.
 *
 * Silently falls back to local state if the backend is unavailable.
 */
export async function reconcileSessionsFromBackend(
  snapshot: SessionsSnapshot,
): Promise<void> {
  try {
    const backendSessions = await getWorkbenchSessions();
    // Skip ids the user (or a tool) just deleted — cascade may still be mid-flight.
    const liveBackend = backendSessions.filter((s) => !isSessionIdTombstoned(s.id));
    const backendMap = new Map(liveBackend.map((s) => [s.id, s]));

    const current = snapshot.getSessions();
    const merged: Session[] = [];
    const claimed = new Set<string>();
    const now = new Date().toISOString();

    for (const local of current) {
      if (isSessionIdTombstoned(local.id) || isSessionIdTombstoned(local.workbenchSessionId)) {
        continue;
      }
      const key = local.workbenchSessionId || local.id;
      const backend = backendMap.get(key) ?? backendMap.get(local.id);
      if (backend) {
        claimed.add(backend.id);
        // Keep stable UI id — only attach / refresh workbench metadata.
        merged.push({
          ...local,
          id: local.id,
          workbenchSessionId: backend.id,
          // Never clobber a real local title with a backend placeholder
          // ("Chat 2026-…", "New Session") — that was wiping auto-titles.
          title: preferSessionTitle(local.title, backend.title as string | undefined),
          startedAt: local.startedAt,
          messageCount: Math.max(backend.messageCount ?? 0, local.messageCount ?? 0),
          provider: backend.provider || local.provider,
          model: (backend.model as string | undefined) || local.model,
          workbenchProvider: backend.provider || local.workbenchProvider,
        });
        continue;
      }

      // No backend match.
      if (!local.workbenchSessionId) {
        // Pure local draft (new empty chat before first message) — keep.
        merged.push(local);
        continue;
      }
      // Linked to a workbench row that no longer exists → server deleted it.
      // Drop from sidebar (delete_session tool / purge / expired).
    }

    for (const bs of liveBackend) {
      if (claimed.has(bs.id) || isSessionIdTombstoned(bs.id)) continue;
      // Prefer attaching to a local empty draft that is waiting for a workbench
      // link (avoids a second row when SSE/reconcile race with first message).
      const pendingIdx = merged.findIndex(
        (s) =>
          !s.workbenchSessionId &&
          !s.isArchived &&
          sessionIsEmpty(s) &&
          !isSessionIdTombstoned(s.id),
      );
      if (pendingIdx >= 0) {
        const pending = merged[pendingIdx];
        claimed.add(bs.id);
        merged[pendingIdx] = {
          ...pending,
          workbenchSessionId: bs.id,
          title: preferSessionTitle(pending.title, bs.title as string | undefined),
          messageCount: Math.max(bs.messageCount ?? 0, pending.messageCount ?? 0),
          provider: bs.provider || pending.provider,
          model: (bs.model as string | undefined) || pending.model,
          workbenchProvider: bs.provider || pending.workbenchProvider,
        };
        continue;
      }
      merged.push({
        id: bs.id,
        title: (bs.title as string | undefined) || 'New Session',
        startedAt: (bs.updatedAt as string | undefined) || now,
        messageCount: bs.messageCount ?? 0,
        lastMessage: 'Conversation started.',
        provider: bs.provider || '',
        model: (bs.model as string | undefined) || '',
        workbenchSessionId: bs.id,
        workbenchProvider: bs.provider || '',
      });
    }

    const finalSessions = dedupeSessions(merged);
    snapshot.setSessions(finalSessions);
    saveSessionsToStorage(finalSessions);
  } catch {
    // Backend unreachable — keep local state intact.
  }
}
