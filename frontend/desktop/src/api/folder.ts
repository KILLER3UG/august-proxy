/* ── Folder picker API ───────────────────────────────────────────────── */
/* Opens a native folder picker via Tauri dialog plugin, with a browser
   fallback using <input type="file" webkitdirectory>. */

import { isTauri } from '@/lib/tauri-detect';

export interface FolderPickResult {
  path: string | null;
  name: string | null;
  cancelled: boolean;
}

/**
 * Open a native folder picker dialog.
 * - In Tauri: uses @tauri-apps/plugin-dialog's open() with directory:true
 * - In browser: uses a hidden <input webkitdirectory> element
 */
export async function openFolderViaTauri(): Promise<FolderPickResult> {
  if (isTauri) {
    // Prefer the dialog plugin (parented to the app window).
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select workspace folder',
      });
      if (selected && typeof selected === 'string') {
        const name = selected.split(/[/\\]/).filter(Boolean).pop() || 'workspace';
        return { path: selected.replace(/\\/g, '/'), name, cancelled: false };
      }
      // User cancelled
      if (selected === null) {
        return { path: null, name: null, cancelled: true };
      }
    } catch (err) {
      console.warn('Tauri dialog plugin failed, trying select_directory command:', err);
    }

    // Fallback: Rust command (also uses dialog plugin on the backend now)
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const selected = await invoke<string | null>('select_directory');
      if (selected) {
        const name = selected.split(/[/\\]/).filter(Boolean).pop() || 'workspace';
        return { path: selected.replace(/\\/g, '/'), name, cancelled: false };
      }
      return { path: null, name: null, cancelled: true };
    } catch (err) {
      console.warn('select_directory failed, falling back to browser picker:', err);
    }
  }

  // Browser fallback
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) {
        const path = file.webkitRelativePath;
        const dirPath = path.substring(0, path.length - file.name.length);
        const fullPath = file.path || dirPath;
        const name = dirPath.split('/').filter(Boolean).pop() || 'workspace';
        resolve({ path: fullPath, name, cancelled: false });
      } else {
        resolve({ path: null, name: null, cancelled: true });
      }
    });

    input.addEventListener('cancel', () => {
      resolve({ path: null, name: null, cancelled: true });
    });

    input.click();
  });
}

/**
 * Given a directory path, derive a human-readable folder name.
 */
export function folderNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : 'workspace';
}
