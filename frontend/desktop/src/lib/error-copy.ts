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
    // FIRST, and deliberately before the provider patterns: every string here
    // is a transport failure in the webview, which means the request never left
    // the machine — the provider never saw it, so no provider-flavoured copy is
    // true of it. `Failed to fetch` is Chromium's whole message for a rejected
    // same-origin fetch (backend restarting, the socket dropped mid-SSE, the
    // window suspended), and it used to fall through to the catch-all below,
    // which told the user their provider had rejected the request and sent them
    // to Settings → Models & Providers to fix a thing that was never the
    // provider. `backend.log` shows the matching side of it:
    // `_ProactorBasePipeTransport._call_connection_lost` while uvicorn is
    // otherwise healthy.
    re: /failed to fetch|networkerror|load failed|network request failed|err_network|err_connection|\beconnrefused\b|\benetunreach\b|\beconnreset\b|stream read error|stream ended without/i,
    title: 'Cannot reach August',
    detail:
      'The app could not reach its own backend, so this request never left the computer — the provider was not involved. Retry; if it keeps happening, restart August.',
  },
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
  // Unmatched text must not accuse the provider: this branch is reached by an
  // empty message, a local failure, or a provider sentence that matches none of
  // the shapes above, and only the last of those is the provider's doing. Say
  // what is actually known — nothing — and hand the raw text to the details
  // element, which is the one place that can show the truth.
  return {
    title: 'Request failed',
    detail: raw
      ? 'Nothing matched a known failure, so this could be the provider or the local backend. The raw message below is exactly what arrived.'
      : 'The request failed without a reason coming back. Retry — if it persists, restart August and check the raw details below.',
    raw,
  };
}
