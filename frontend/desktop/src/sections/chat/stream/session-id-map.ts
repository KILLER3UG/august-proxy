/**
 * Map workbench `wb_*` ids ↔ UI `sess_*` ids for stream store / runtime.
 * Backend SSE and POST always use workbench ids; local state prefers UI ids.
 */

import { useSessionsStore } from '@/store/sessions';

/** Resolve a workbench or UI id to the stable UI session id when known. */
export function resolveUiSessionId(sessionOrWorkbenchId: string): string {
  if (!sessionOrWorkbenchId) return sessionOrWorkbenchId;
  const sessions = useSessionsStore.getState().sessions;
  const hit = sessions.find(
    (s) =>
      s.id === sessionOrWorkbenchId ||
      s.workbenchSessionId === sessionOrWorkbenchId,
  );
  return hit?.id || sessionOrWorkbenchId;
}

/** Resolve a UI or workbench id to the workbench id used for backend SSE/POST. */
export function resolveWorkbenchSessionId(sessionOrWorkbenchId: string): string {
  if (!sessionOrWorkbenchId) return sessionOrWorkbenchId;
  const sessions = useSessionsStore.getState().sessions;
  const hit = sessions.find(
    (s) =>
      s.id === sessionOrWorkbenchId ||
      s.workbenchSessionId === sessionOrWorkbenchId,
  );
  return hit?.workbenchSessionId || hit?.id || sessionOrWorkbenchId;
}
