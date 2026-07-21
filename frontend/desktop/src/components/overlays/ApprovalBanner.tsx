/* ── ApprovalBanner ───────────────────────────────────────────────────── */
/* Session-level permission UI. Renders Cursor-style PermissionRequiredCard */
/* via MutationDiffCards (Allow / Always in project / Deny + Confirm).     */

import { useEffect } from 'react';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import type { SessionStatus } from '@/hooks/useSessionStatus';
import { MutationDiffCards } from '@/components/overlays/MutationDiffCards';

export type { SessionStatus } from '@/hooks/useSessionStatus';

type Props = {
  sessionId: string | null;
  pollIntervalMs?: number;
  onStatusChange?: (status: SessionStatus | null) => void;
  /** Backend started a continuation turn — reattach chat SSE from this seq. */
  onContinued?: (sinceSeq: number) => void;
};

export function ApprovalBanner({
  sessionId,
  pollIntervalMs = 2000,
  onStatusChange,
  onContinued,
}: Props) {
  const { data: status } = useSessionStatus(sessionId, pollIntervalMs);

  useEffect(() => {
    onStatusChange?.(status ?? null);
  }, [status, onStatusChange]);

  if (!sessionId) return null;

  return (
    <div data-testid="approval-banner">
      <MutationDiffCards
        sessionId={sessionId}
        status={status}
        onContinued={onContinued}
      />
    </div>
  );
}

export default ApprovalBanner;
