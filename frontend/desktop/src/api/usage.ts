/* ── usage-api ─ typed client for /api/usage/* ──────────────────────── */

import { api } from './client';

export type UsageRange = '7d' | '30d';

export interface UsageStats {
  range: UsageRange;
  /** BILLED tokens (input + output). Cache reads are reported separately so a
   *  warm session's prompt re-reads never inflate this number. */
  totalTokens: number;
  /** Prompt tokens served from the provider cache in this range. */
  cacheHitTokens: number;
  /** Prompt tokens written to the cache in this range (billed as input). */
  cacheMissTokens: number;
  /** cacheHit / (cacheHit + cacheMiss); 0 when no cache activity was recorded. */
  cacheHitRate: number;
  peakTokens: number;
  sessions: number;
  messages: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  favoriteModel: string | null;
  favoriteModelShare: number;
  at: string;
}

export interface HeatmapCell {
  date: string; // YYYY-MM-DD
  count: number;
}

export interface ModelShare {
  model: string;
  tokens: number;
  percent: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export interface DailyTokens {
  date: string; // YYYY-MM-DD
  tokens: number;
  models: { model: string; tokens: number }[];
}

function withRange(path: string, range: UsageRange) {
  return `${path}?range=${range}`;
}

export interface SessionUsage {
  sessionId: string;
  totalEvents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCost: number;
  /** True when any billed token was priced from August's family table rather
   *  than a price set on the model — the difference between "$0.41" and
   *  "~$0.41". */
  costEstimated: boolean;
  model: string | null;
  provider: string | null;
  /** Provider-reported input_tokens of the FINAL sub-call of the latest turn —
   *  the true current context fill (system prompt + tools + messages, counted
   *  once). The context gauge derives its percentage from this value. */
  contextTokens: number;
  /** Alias kept for clarity in some call sites. */
  latestContextTokens?: number;
  /** Universal prompt-cache split (Anthropic cache_read vs OpenAI-compatible
   *  prompt_cache_hit) accumulated across the session. */
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  cacheHitRate?: number;
  events: {
    id: number;
    requestType: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    /** Per-event context fill (falls back to inputTokens for pre-migration rows). */
    contextTokens: number;
    totalTokens: number;
    totalCost: number;
    createdAt: string;
  }[];
}

/** The four aggregate fields a sidebar `+input / −output` delta needs. Cheaper
 *  than {@link SessionUsage}, which also carries the 500-row event list and a
 *  per-event pricing sweep. Keyed by the session id the caller asked for. */
export interface SessionTokenDelta {
  sessionId: string;
  totalEvents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
}

export const usageApi = {
  stats:    (range: UsageRange = '30d')       => api.get<UsageStats>(withRange('/api/usage/stats', range)),
  heatmap:  (range: UsageRange = '30d')       => api.get<{ results: HeatmapCell[] }>(withRange('/api/usage/heatmap', range)),
  byModel:  (range: UsageRange = '30d')       => api.get<{ results: ModelShare[] }>(withRange('/api/usage/by-model', range)),
  byDay:    (range: UsageRange = '30d')       => api.get<{ results: DailyTokens[] }>(withRange('/api/usage/by-day', range)),
  /** Per‑session usage breakdown from the backend usage_events table. */
  session:  (sessionId: string)               => api.get<SessionUsage>(`/api/usage/session?id=${encodeURIComponent(sessionId)}`),
  /** Many sessions at once — ONE grouped query behind the sidebar's per-row
   *  delta. Ask for every id the list is about to render; never one call per
   *  row (see `get_usage_batch`). Ids with no usage rows are absent.
   *
   *  Capped HERE as well as on the server, because the failure modes are not
   *  the same shape: `rest.MAX_USAGE_BATCH_IDS` truncates the `IN (...)`, but
   *  the route's `Query(max_length=8000)` answers a longer `ids` string with a
   *  422 — and one 422 zeroes every row's delta, not just the tail. 250 ids of
   *  the ~24-char `wb_…` form is ~6.3 KB, safely under that ceiling. */
  sessions: (sessionIds: string[])            => {
    const ids = Array.from(new Set(sessionIds.map((id) => id.trim()).filter(Boolean))).slice(0, 250);
    if (ids.length === 0) return Promise.resolve<{ results: Record<string, SessionTokenDelta> }>({ results: {} });
    return api.get<{ results: Record<string, SessionTokenDelta> }>(
      `/api/usage/sessions?ids=${ids.map(encodeURIComponent).join(',')}`,
    );
  },
};
