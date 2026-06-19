/* ── "Where do I get this?" links for service credentials ──────────── */
/* Single source of truth so URLs are easy to maintain and the field
 * labels in Services.tsx stay tidy. Group by service; each entry is the
 * authoritative page where the user creates or copies that value.
 *
 * Keep URLs in sync with the product docs at
 *   docs/connections/<service>.md (when present).
 */

export const SERVICE_LINKS = {
  google: {
    /** Google Cloud Console → APIs & Services → Credentials. Both OAuth
     *  client ID and client secret are created/managed on this page. */
    clientIdAndSecret: 'https://console.cloud.google.com/apis/credentials',
    /** Google docs on Authorized redirect URIs (where the user pastes
     *  the August callback URL after creating the OAuth client). */
    redirectUriDocs: 'https://support.google.com/cloud/answer/6158849',
  },
  github: {
    /** Fine-grained PATs are the current recommendation. The classic
     *  fallback is https://github.com/settings/tokens. */
    token: 'https://github.com/settings/tokens?type=beta',
  },
  slack: {
    /** Slack API → Your Apps → select app → "OAuth & Permissions" →
     *  "Bot User OAuth Token" (after installing the app to workspace). */
    botToken: 'https://api.slack.com/apps',
    /** Slack help article on locating the workspace / team ID. */
    teamId:
      'https://slack.com/help/articles/221769328-Locate-your-Slack-URL-or-ID',
  },
} as const;
