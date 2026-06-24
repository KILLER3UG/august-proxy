/* ── Tauri runtime detection ──────────────────────────────────────────── */
/** Returns true when running inside the Tauri v2 webview. */
export const isTauri =
  typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__ !== undefined;
