/* ── Pairing — the mobile shell's half of phone pairing ────────────────
 *
 * The desktop shell generates a per-install token
 * (frontend/desktop/src-tauri/src/backend.rs → `local_api_token`) and the
 * backend's sensitive local routes require it
 * (backend-py/app/lib/local_api_auth.py → `X-August-Local-Token`). A
 * phone's WebView is not Tauri, so it has no IPC to ask and sends no
 * header — which is why those routes answer 401 for a phone today.
 *
 * The token therefore travels with the URL the phone opens:
 *
 *     http://<host>:<port>/#august-token=<token>
 *
 * The FRAGMENT is the form, not the query string: a fragment is never
 * sent to the server and never appears in a `Referer` header, so a token
 * in it cannot reach an access log. The web client reads it on boot and
 * takes it back out of the URL
 * (frontend/desktop/src/api/client.ts → `captureTokenFromUrl`).
 *
 * This module is the other end of that: it pulls the token back out of a
 * URL the user pasted, and it builds the little script that hands the
 * token to the web app WITHOUT putting it in a URL at all.
 *
 * The parameter name is the same one the web client reads
 * (`LOCAL_TOKEN_URL_PARAM` in frontend/desktop/src/api/client.ts). The two
 * packages cannot share a module, so the name is written down in both
 * places — if one side changes it, the other has to change with it.
 */

export const LOCAL_TOKEN_URL_PARAM = 'august-token';

/** What a pasted address turned out to be. */
export type PairingInput = {
  /** The backend address, with the token taken out of it. */
  baseUrl: string;
  /** The per-install token, or null when the input carried none. */
  token: string | null;
};

function decodeToken(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    /* a malformed escape is used as-is */
    return raw;
  }
}

/**
 * Pull a pairing URL apart.
 *
 * Accepts a plain backend address (`192.168.1.10:8085`), a full pairing
 * URL (`http://192.168.1.10:8085/#august-token=abc`), or a URL whose
 * token rides in the query string instead of the fragment. The token is
 * removed from the address it came from, and any OTHER fragment or query
 * part is kept — the web client does the same, so the two agree.
 */
export function parsePairingInput(raw: string): PairingInput {
  const value = (raw ?? '').trim();
  if (!value) return { baseUrl: '', token: null };

  let token: string | null = null;
  let rest = value;

  const hashIndex = value.indexOf('#');
  if (hashIndex >= 0) {
    const parts = value.slice(hashIndex + 1).split('&');
    const found = parts.find((part) => part.startsWith(`${LOCAL_TOKEN_URL_PARAM}=`));
    if (found) {
      token = decodeToken(found.slice(LOCAL_TOKEN_URL_PARAM.length + 1));
      const kept = parts.filter((part) => !part.startsWith(`${LOCAL_TOKEN_URL_PARAM}=`));
      rest = value.slice(0, hashIndex) + (kept.length ? `#${kept.join('&')}` : '');
    }
  }

  if (token === null) {
    const queryIndex = rest.indexOf('?');
    if (queryIndex >= 0) {
      const parts = rest.slice(queryIndex + 1).split('&');
      const found = parts.find((part) => part.startsWith(`${LOCAL_TOKEN_URL_PARAM}=`));
      if (found) {
        token = decodeToken(found.slice(LOCAL_TOKEN_URL_PARAM.length + 1));
        const kept = parts.filter((part) => !part.startsWith(`${LOCAL_TOKEN_URL_PARAM}=`));
        rest = rest.slice(0, queryIndex) + (kept.length ? `?${kept.join('&')}` : '');
      }
    }
  }

  return { baseUrl: rest, token: token && token.trim() ? token.trim() : null };
}

/**
 * Build the pairing URL the desktop prints. The mirror of
 * `parsePairingInput`, and the same shape the desktop's pairing surface
 * produces (frontend/desktop/src/api/client.ts → `buildPairingUrl`).
 */
export function buildPairingUrl(baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/#${LOCAL_TOKEN_URL_PARAM}=${encodeURIComponent(token)}`;
}

/**
 * The script the WebView runs BEFORE the page loads.
 *
 * It publishes the token as `window.__HARNESS_LOCAL_TOKEN__`, which is one
 * of the two sources the web client reads
 * (frontend/desktop/src/api/client.ts → `hostGlobalToken`). The token
 * therefore never appears in the WebView's URL at all: not in the address
 * bar, not in the page history, not in a screenshot of the phone — and
 * unlike a fragment, a reload of the WebView gets the token again.
 *
 * Returns an empty string when there is no token, which is the ordinary
 * case: a backend started outside the desktop shell has no token
 * configured, and the gate is a no-op by construction.
 */
export function tokenBootstrapScript(token: string | null): string {
  if (!token) return '';
  return `window.__HARNESS_LOCAL_TOKEN__ = ${JSON.stringify(token)};`;
}
