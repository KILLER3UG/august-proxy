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
 * Reveal a file in the OS file manager (Explorer with the file selected on
 * Windows, Finder on macOS). Falls back to opening the file with its
 * default app when the reveal command is unavailable.
 */
export async function revealInFolder(path: string): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke<string>('reveal_in_folder', { path });
  } catch (err) {
    console.warn('[tauri-shell] reveal_in_folder failed, opening directly:', err);
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(path);
  }
}

/**
 * Open the OS folder picker and return the chosen folder, or null if the user
 * cancelled. Backed by the existing `select_directory` Rust command, which
 * runs the picker FROM Rust via the dialog plugin — so no JS dialog ACL
 * (no `dialog:allow-save` capability) is needed, exactly like
 * reveal_in_folder / read_file_base64 before it. Returns null off-desktop.
 */
export async function selectDirectory(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string | null>('select_directory', {});
  } catch (err) {
    console.warn('[tauri-shell] select_directory failed:', err);
    return null;
  }
}

/** What the bulk copy reports back. camelCase — matches the Rust CopyReport. */
export interface CopyReport {
  copied: number;
  failed: number;
  skipped: number;
  collisions: string[];
}

/**
 * Copy a batch of files into `destDir`, flat (no subdirectories). Off-desktop
 * there is no folder picker or FS write, so this returns null and the caller
 * falls back to sequential anchor downloads (the documented non-desktop path).
 *
 * A basename already present in the destination is SKIPPED, not overwritten —
 * the report carries the collisions so the UI can say so rather than claim a
 * count that silently clobbered files.
 */
export async function copyFilesToDir(
  destDir: string,
  paths: string[],
): Promise<CopyReport | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<CopyReport>('copy_files_to_dir', { destDir, paths });
  } catch (err) {
    console.warn('[tauri-shell] copy_files_to_dir failed:', err);
    return null;
  }
}
