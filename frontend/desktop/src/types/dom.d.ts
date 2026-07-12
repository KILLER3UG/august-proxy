/* ── DOM type extensions for vendor-prefixed attributes ─────────────── */

import 'react';

declare module 'react' {
  interface InputHTMLAttributes<T, TDefault = T> {
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

/* ── Window vendor globals ─────────────────────────────────────────────
 * Typed escape hatches for runtime APIs that don't ship with the lib
 * target. Each one is structurally typed — consumers should narrow
 * with `instanceof` or feature-detect at the call site.
 */
declare global {
  interface Window {
    /** Web Speech API — constructor for streaming speech recognition.
     *  Structural shape; avoids relying on the optional `SpeechRecognition`
     *  global from lib.dom.d.ts (which has shifted across TS versions). */
    SpeechRecognition?: new () => SpeechRecognitionLike;
    /** Safari/older Chrome alias. */
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    /** Tauri 2 internals — present in the desktop shell, absent in browser dev. */
    __TAURI_INTERNALS__?: unknown;
    /** highlight.js — populated by the markdown renderer at startup. */
    hljs?: {
      highlightElement: (el: Element) => void;
      highlightAuto: (code: string) => { value: string };
    };
  }
}

/** Minimal structural shape for the Web Speech API that matches what
 *  the chat code actually uses. Kept here (not in workbench.ts) because
 *  it's a vendor DOM extension, not a project domain type. */
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>; resultIndex: number }) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export {};
