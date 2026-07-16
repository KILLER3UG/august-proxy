/* ── Sign in with Google / Gmail for August accounts ───────────────── */
/* Reuses the existing Google OAuth PKCE flow (service connections), then
 * maps the Google profile onto a local AugustAccount. */

import { api } from '@/api/client';
import { openExternal } from '@/lib/tauri-shell';
import { upsertGoogleAccount, type AugustAccount } from '@/store/account';

export type GoogleProfile = {
  email: string;
  displayName?: string;
  picture?: string;
  googleSub?: string;
};

type GoogleConnectionCard = {
  connected?: boolean;
  email?: string | null;
  account?: string | null;
  displayName?: string | null;
  picture?: string | null;
  googleSub?: string | null;
};

type ConnectionsResponse = {
  connections?: {
    google?: GoogleConnectionCard;
  };
};

function profileFromCard(card: GoogleConnectionCard | undefined): GoogleProfile | null {
  const email = (card?.email || card?.account || '').trim();
  if (!email) return null;
  return {
    email,
    displayName: card?.displayName ?? undefined,
    picture: card?.picture ?? undefined,
    googleSub: card?.googleSub ?? undefined,
  };
}

async function fetchGoogleProfile(): Promise<GoogleProfile | null> {
  const data = await api.get<ConnectionsResponse>('/api/service-connections');
  return profileFromCard(data.connections?.google);
}

/**
 * Start Google OAuth in the browser, wait for success, then create/switch
 * the August account from the Google profile.
 */
export async function signInWithGoogle(opts?: {
  timeoutMs?: number;
}): Promise<AugustAccount> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;

  // Already signed into Google workspace? Reuse that identity immediately.
  const existing = await fetchGoogleProfile();
  if (existing) {
    return upsertGoogleAccount(existing);
  }

  const start = await api.post<{ authUrl?: string; message?: string }>(
    '/api/service-connections/google/auth',
    { email: '' },
  );
  if (!start.authUrl) {
    throw new Error(
      start.message ||
        'Google sign-in is not configured. Set GOOGLE_OAUTH_CLIENT_ID (Desktop OAuth client).',
    );
  }

  const opened = await openExternal(start.authUrl);
  if (!opened) {
    // Fallback: try window.open for web/dev.
    window.open(start.authUrl, 'august-google-oauth', 'width=520,height=720');
  }

  const profile = await waitForGoogleProfile(timeoutMs);
  return upsertGoogleAccount(profile);
}

function waitForGoogleProfile(timeoutMs: number): Promise<GoogleProfile> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const started = Date.now();

    const finish = (profile: GoogleProfile | null, err?: Error) => {
      if (settled) return;
      settled = true;
      window.clearInterval(pollId);
      window.removeEventListener('message', onMessage);
      if (profile) resolve(profile);
      else reject(err ?? new Error('Google sign-in timed out or was cancelled.'));
    };

    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        ok?: boolean;
        email?: string;
        displayName?: string;
        picture?: string;
      } | null;
      if (!data || data.type !== 'august-google-oauth') return;
      if (!data.ok) {
        finish(null, new Error('Google sign-in failed. Try again.'));
        return;
      }
      if (data.email) {
        finish({
          email: data.email,
          displayName: data.displayName,
          picture: data.picture,
        });
        return;
      }
      void fetchGoogleProfile().then((p) => {
        if (p) finish(p);
      });
    };

    window.addEventListener('message', onMessage);

    const pollId = window.setInterval(() => {
      if (Date.now() - started > timeoutMs) {
        finish(null, new Error('Google sign-in timed out. Try again.'));
        return;
      }
      void fetchGoogleProfile()
        .then((p) => {
          if (p) finish(p);
        })
        .catch(() => {
          /* keep polling */
        });
    }, 1500);
  });
}
