/* ── Shared react-query key factory (review-inbox cluster) ────────────── */
/* The produced arrays are shape-identical to the literals they replaced, */
/* so cache hits and invalidations behave exactly as before. Note the     */
/* cluster-wide invalidation key is the 1-element ['harness-proposals'] — */
/* ['harness-proposals', undefined] hashes differently in the query cache */
/* and would NOT match, so the factory branches on the missing filter.    */

/** Query keys for the review-inbox cluster (ambient badge + harness
 *  proposals). Memory proposals and curator-* keys stay inline at their
 *  call sites — only this cluster is centralized. */
export const qk = {
  /** Ambient pending-decisions badge (useReviewInboxCount). */
  reviewInboxCount: ['review-inbox-count'] as const,
  /** Harness self-improve proposals (self-improve / distiller / promotion).
   *  Omit `filter` only for the cluster-wide invalidation key. */
  harnessProposals: (
    filter?: string,
  ): ['harness-proposals'] | ['harness-proposals', string] =>
    filter === undefined ? ['harness-proposals'] : ['harness-proposals', filter],
};
