/** Which dispatch wave is actually running, from live workstream names. */

export function resolveActiveWave(
  waves: string[][] | undefined,
  liveWorkstreams: Iterable<string>,
  jobStatus?: string,
): { now: number; total: number } {
  const list = (waves ?? []).map((w) => w.filter(Boolean));
  const total = list.length;
  if (total === 0) return { now: 0, total: 0 };

  const live = new Set([...liveWorkstreams].map((n) => n.trim()).filter(Boolean));
  if (live.size > 0) {
    const idx = list.findIndex((w) => w.some((n) => live.has(n)));
    if (idx >= 0) return { now: idx + 1, total };
  }
  if (jobStatus === 'completed') return { now: total, total };
  if (jobStatus === 'failed' || jobStatus === 'partial') {
    const idx = list.findIndex((w) => w.length > 0);
    return { now: Math.max(1, idx + 1), total };
  }
  return { now: 1, total };
}
