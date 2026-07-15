/* ── useChatUsage ─────────────────────────────────────────────────────── */
/* Per-session token + cost usage for the context ring.                   */

import { useEffect, useState } from 'react';
import { usageApi } from '@/api/usage';

export type SessionUsageState = {
  total: number;
  input: number;
  output: number;
  contextTokens: number;
  totalCost?: number;
} | null;

export function useChatUsage(
  sessionId: string | null,
  workbenchSessionId?: string | null,
  fallbackWorkbenchId?: string | null,
) {
  const [sessionUsage, setSessionUsage] = useState<SessionUsageState>(null);

  useEffect(() => {
    const sotId =
      workbenchSessionId ||
      fallbackWorkbenchId ||
      (sessionId?.startsWith('wb_') ? sessionId : '') ||
      sessionId;
    if (!sotId) {
      setSessionUsage(null);
      return;
    }

    let cancelled = false;
    usageApi
      .session(sotId)
      .then((data) => {
        if (cancelled) return;
        setSessionUsage({
          total: data.totalTokens,
          input: data.totalInputTokens,
          output: data.totalOutputTokens,
          contextTokens: data.contextTokens ?? 0,
          totalCost: data.totalCost ?? 0,
        });
      })
      .catch(() => {
        if (!cancelled) setSessionUsage(null);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, workbenchSessionId, fallbackWorkbenchId]);

  return sessionUsage;
}
