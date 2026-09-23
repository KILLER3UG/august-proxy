import { useEffect } from 'react';
import { ensureSessionHistory } from '../stream/session-history';

/** History readiness belongs to the session, not to transcript emptiness or
 * a component mount. Undo to [] must not replay a cached successful request. */
export function useSessionHistory(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId) return;
    const load = () => { void ensureSessionHistory(sessionId); };
    load();
    window.addEventListener('online', load);
    window.addEventListener('focus', load);
    return () => {
      window.removeEventListener('online', load);
      window.removeEventListener('focus', load);
    };
  }, [sessionId]);
}
