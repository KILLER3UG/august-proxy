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
