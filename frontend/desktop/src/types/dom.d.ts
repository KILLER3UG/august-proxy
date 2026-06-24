/* ── DOM type extensions for vendor-prefixed attributes ─────────────── */

import 'react';

declare module 'react' {
  interface InputHTMLAttributes<T> {
    /** Non-standard Chrome/Edge attribute that opens a directory picker. */
    webkitdirectory?: string;
    /** Non-standard directory picker attribute (alternative name). */
    directory?: string;
  }
}

/** Chrome exposes the full filesystem path on File objects from
 *  <input type="file" webkitdirectory> selections. */
declare global {
  interface File {
    /** Full absolute path of the selected file (Chrome-only). */
    path?: string;
  }
}

export {};
