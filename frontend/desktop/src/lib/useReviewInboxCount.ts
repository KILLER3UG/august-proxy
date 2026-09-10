/* ── useReviewInboxCount — ambient badge for every pending human decision ── */
/* The learning loop files proposals (harness self-improve), distiller
 * drafts (routed through the same queue), and memory-retire proposals
 * (separate store). Before this hook the counts existed only inside
 * Settings sections nobody navigates to; a Sep-4 proposal sat unseen for
 * a week. One cheap polled route (/api/harness/proposals/inbox/count)
 * feeds both the settings-rail badge and the tray footer row. */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export interface InboxCount {
  harness: number;
  memory: number;
  total: number;
}

export const REVIEW_INBOX_QUERY_KEY = ['review-inbox-count'] as const;

export function useReviewInboxCount(enabled = true): InboxCount {
  const query = useQuery({
    queryKey: REVIEW_INBOX_QUERY_KEY,
    queryFn: () => api.get<InboxCount>('/api/harness/proposals/inbox/count'),
    enabled,
    // 60s: passes that file proposals run on hours-long cadences; the
    // badge is ambience, not a live feed.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  return query.data ?? { harness: 0, memory: 0, total: 0 };
}

export function invalidateReviewInboxCount(qc: {
  invalidateQueries: (o: { queryKey: readonly unknown[] }) => void;
}) {
  void qc.invalidateQueries({ queryKey: REVIEW_INBOX_QUERY_KEY });
}
