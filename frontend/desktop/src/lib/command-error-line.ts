/**
 * Minimal-output transcript (plan §4.1/§4.2): a failed command shows exactly
 * ONE red line inline — the structured digest when the output carries one
 * (pytest-style `3 failed, 2 passed in 12.34s`), else the first error-looking
 * line, else the last non-empty line. Full output stays behind the click.
 *
 * Pure + idempotent: running the helper on an already-extracted one-liner
 * returns it unchanged, so live streams (digest computed in
 * makeStreamHandlers) and replayed sessions (full text persisted on the
 * tool entry) render identically.
 */

/** Pytest/tap-style structured summary line, e.g. `= 3 failed, 2 passed in 12.34s =`. */
const STRUCTURED_DIGEST_RE =
  /(?:=+\s*)?(\d+\s+(?:failed|errors?|passed|skipped|xfailed)[^\n=]{0,80})(?:\s*=+)?\s*$/im;

/** Lines that look like the start of an error (language/tool agnostic).
 *  Python traceback frame lines (`File "…"`, `raise …`) are NOT errors —
 *  the exception line at the foot of the block is. */
const ERROR_LINE_RE =
  /^(?:Traceback|\s*(?:[A-Za-z_][\w.]*)?(?:Error|Exception|Failure|Panic)[\s:(]|\s*(?:ERROR|FATAL|FAILED|FAIL|error(?:\[[^\]]+\])?:|fatal:|command not found|permission denied|assert(?:ion)? failed|✗|×)\b)/i;

function truncate(line: string, max: number): string {
  const trimmed = line.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Extract the single inline line for a failed command.
 * Returns null when there is no output at all to summarise.
 */
export function commandErrorOneLiner(raw: string | null | undefined, max = 120): string | null {
  if (!raw) return null;
  const text = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim();
  if (!text) return null;

  // 1. Structured digest wins — it IS the test-run verdict.
  const digest = text.match(STRUCTURED_DIGEST_RE);
  if (digest && digest[1].trim()) return truncate(digest[1], max);

  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  if (lines.length === 0) return null;

  // 2. First error-looking line (tracebacks surface the exception line, not
  //    the "Traceback" header, which carries no information on its own).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^Traceback \(most recent call last\)/i.test(line)) {
      // Python traceback: the last line of the block is the exception.
      for (let j = i + 1; j < lines.length; j++) {
        if (ERROR_LINE_RE.test(lines[j])) return truncate(lines[j], max);
      }
    }
    if (ERROR_LINE_RE.test(line) && !/^Traceback/i.test(line)) {
      return truncate(line, max);
    }
  }

  // 3. Fallback: the last non-empty line (errors usually end the output).
  return truncate(lines[lines.length - 1], max);
}
