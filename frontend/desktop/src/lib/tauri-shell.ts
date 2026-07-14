/* ── Tauri shell helpers ────────────────────────────────────────────── */
/* Thin wrappers around @tauri-apps/plugin-shell with browser fallbacks.
 *
 * Used by Integrations for OAuth flows — we want the user to land in
 * their system default browser, not an in-app popup, so cookies and
 * password managers behave like any other login.
 *
 * Both helpers no-op safely when called from a plain web build. */

import { isTauri } from '@/lib/tauri-detect';

/**
 * Open a URL in the user's system default browser (Tauri) or a new
 * tab (browser dev / web build).
 *
 * Returns `true` if a real external window was opened, `false` if we
 * fell back to `window.open` (which most browsers block as a popup
 * unless triggered synchronously from a user gesture).
 */
export async function openExternal(url: string): Promise<boolean> {
  if (!url) return false;

  if (isTauri) {
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      // open(url, openWith?) — passing undefined lets the OS pick the
      // default handler. We use a strict no-arg call so the user
      // always lands in the system browser, never the webview.
      await open(url);
      return true;
    } catch (err) {
      console.warn('[tauri-shell] open() failed, falling back to window.open:', err);
    }
  }

  // Browser fallback (vite dev / web build). Note: most browsers
  // require this to be called synchronously from a user gesture, so
  // the caller should invoke from an onClick — not from a setTimeout.
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  return win !== null;
}

/**
 * Reveal a file or URL using the OS "open with default app" affordance.
 * Currently unused but exported for the future "Open logs" / "Open
 * config folder" buttons that fit the Integrations IA.
 */
export async function revealInFolder(path: string): Promise<void> {
  if (!isTauri) return;
  const { open } = await import('@tauri-apps/plugin-shell');
  await open(path);
}
