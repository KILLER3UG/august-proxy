/* ── usage-api ─ typed client for /api/usage/* ──────────────────────── */

import { api } from './client';

export type UsageRange = '7d' | '30d';

export interface UsageStats {
  range: UsageRange;
  totalTokens: number;
  sessions: number;
  messages: number;
  activeDays: number;
  currentStreak: number;
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
}

export interface DailyTokens {
  date: string; // YYYY-MM-DD
  tokens: number;
}

function withRange(path: string, range: UsageRange) {
  return `${path}?range=${range}`;
}

export const usageApi = {
  stats:    (range: UsageRange = '30d')       => api.get<UsageStats>(withRange('/api/usage/stats', range)),
  heatmap:  (range: UsageRange = '30d')       => api.get<{ results: HeatmapCell[] }>(withRange('/api/usage/heatmap', range)),
  byModel:  (range: UsageRange = '30d')       => api.get<{ results: ModelShare[] }>(withRange('/api/usage/by-model', range)),
  byDay:    (range: UsageRange = '30d')       => api.get<{ results: DailyTokens[] }>(withRange('/api/usage/by-day', range)),
};
