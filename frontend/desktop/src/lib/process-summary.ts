/**
 * One-line process summary for the settled ActivitySummary header.
 * Prefer a short prose gist from thinking text; callers
 * fall back to count segments when this returns null.
 */

export function buildProcessSummaryLine(thinkingParts: string[]): string | null {
  const joined = thinkingParts
    .map((t) =>
      t
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]+`/g, ' ')
        .replace(/[#*_>[\]()-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join(' ');

  if (joined.length < 12) return null;

  // Prefer a complete first sentence when it is a useful length.
  const sentenceMatch = joined.match(/^(.{12,140}?[.!?])(?:\s|$)/);
  let line = (sentenceMatch?.[1] || joined.slice(0, 110)).trim();
  if (!sentenceMatch && joined.length > line.length) {
    line = line.replace(/\s+\S*$/, '').trim();
  }
  if (line.length < 12) return null;

  if (/^[a-z]/.test(line)) {
    line = line[0].toUpperCase() + line.slice(1);
  }
  return line;
}
