/**
 * Map raw upstream error text to friendly, actionable copy for chat
 * surfaces. The raw text is never thrown away — it stays available for an
 * expandable <details> so power users can still see the provider's words.
 */

export interface FriendlyError {
  title: string;
  detail: string;
  raw: string;
}

const KNOWN_PATTERNS: Array<{ re: RegExp; title: string; detail: string }> = [
  {
    re: /session_id.*expected string, received null|session_id.*null/i,
    title: 'Provider rejected the request',
    detail:
      'The gateway rejected this request format. Retry — if it persists, try another model or provider.',
  },
  {
    re: /401|unauthorized|invalid api key|authentication|api key/i,
    title: 'Provider authentication failed',
    detail: 'Check the API key for this provider in Settings → Models & Providers.',
  },
  {
    re: /402|insufficient|billing|quota|payment|credits/i,
    title: 'Provider quota or billing issue',
    detail: 'The provider needs credits or a raised limit before it will answer.',
  },
  {
    re: /429|rate limit|too many requests/i,
    title: 'Rate limited',
    detail: 'The provider is throttling requests — wait a moment and retry.',
  },
  {
    re: /model.*not found|unknown model|invalid model|model id/i,
    title: 'Model not found',
    detail: 'This model id is not available on the provider — pick another model.',
  },
  {
    re: /context.*(?:length|window|overflow|too long|exceeded)|maximum context/i,
    title: 'Context too long',
    detail: 'The conversation exceeds this model’s window — free up chat memory or start a new chat.',
  },
  {
    re: /timeout|timed out/i,
    title: 'Request timed out',
    detail: 'The provider did not respond in time — retry.',
  },
  {
    re: /connection|network error|dns|connect/i,
    title: 'Network error',
    detail: 'Could not reach the provider — check your connection and the provider base URL.',
  },
];

/** Best-effort friendly copy for a raw upstream error message. */
export function friendlyError(message: string | null | undefined): FriendlyError {
  const raw = message || '';
  for (const p of KNOWN_PATTERNS) {
    if (p.re.test(raw)) {
      return { title: p.title, detail: p.detail, raw };
    }
  }
  return {
    title: 'Request failed',
    detail: 'The provider rejected the request. Retry, or check the provider settings.',
    raw,
  };
}
