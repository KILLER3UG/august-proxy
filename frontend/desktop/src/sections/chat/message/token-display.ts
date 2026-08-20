/** Compact token count for the usage chip: 999 → "999", 1234 → "1.2k", 1720600 → "1.7M". */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

/** Output tokens per second for the usage chip, or null when the turn
 *  carries no generation timing (old persisted messages). */
export function formatTokensPerSecond(usage: {
  outputTokens: number;
  durationMs?: number;
}): string | null {
  const ms = usage.durationMs;
  if (!ms || ms <= 0 || usage.outputTokens <= 0) return null;
  const rate = usage.outputTokens / (ms / 1000);
  if (!Number.isFinite(rate)) return null;
  return rate >= 100 ? String(Math.round(rate)) : rate.toFixed(1);
}

/** Compact generation duration: 812 → "812ms", 4500 → "4.5s", 130000 → "2m 10s". */
export function formatTurnDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
