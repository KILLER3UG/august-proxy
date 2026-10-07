/**
 * useActiveSessions — the one owner for "which sessions have a turn running".
 *
 * Two surfaces gate on this: the quit confirm (QuitConfirmModal) and the
 * update overlay's restart warning. It used to live inline in the quit modal;
 * a second copy is how the two would drift (one of them forgetting the
 * workbench-id lookup, the audit fix that made background work visible).
 *
 * Status maps are keyed by WORKBENCH id (the realtime bridge writes wb_*),
 * so both id forms are checked — otherwise background work on a session is
 * silently missed.
 */

import { useMemo } from 'react';
import { useSessionsStore } from '@/store/sessions';
import { useActiveChatStreamsStore } from '@/store/chat-active-streams';
import type { SessionStatus } from '@/store/sessions/types';

export function isActiveStatus(status: SessionStatus | undefined): boolean {
  return status === 'working' || status === 'streaming';
}

export function useActiveSessions() {
  const sessions = useSessionsStore((s) => s.sessions);
  const sessionStates = useSessionsStore((s) => s.sessionStates);
  const activeChatSessions = useActiveChatStreamsStore((s) => s.active);

  return useMemo(() => {
    const merged: Record<string, SessionStatus> = { ...sessionStates };
    for (const [id, status] of Object.entries(activeChatSessions)) {
      if (!merged[id]) merged[id] = status;
    }
    return sessions.filter(
      (s) =>
        isActiveStatus(merged[s.id]) ||
        (s.workbenchSessionId ? isActiveStatus(merged[s.workbenchSessionId]) : false),
    );
  }, [sessions, sessionStates, activeChatSessions]);
}
