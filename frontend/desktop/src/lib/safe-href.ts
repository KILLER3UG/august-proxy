/**
 * Href guard for URLs the model or a tool produced.
 *
 * Search hits and markdown links arrive as attacker-influenced strings and are
 * rendered into the privileged Tauri webview (markdown via
 * dangerouslySetInnerHTML), so a `javascript:` / `data:` / `file:` target would
 * execute with app privileges. Only web schemes are ever passed through.
 */

const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

/** Returns `value` when it is safe for an <a href>, or null to drop the link. */
export function safeExternalHref(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  // Browsers strip tabs/newlines from URLs, so `java\nscript:` is a real
  // obfuscation. Compare the scheme on a control-character-free copy.
  // eslint-disable-next-line no-control-regex -- those control bytes are exactly what this pattern is here to strip
  const probe = raw.replace(/[\s\u0000-\u001f]+/g, '');
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(probe);
  // No scheme means a relative or fragment link, which cannot run a script.
  if (!scheme) return raw;
  return SAFE_PROTOCOLS.has(scheme[0].toLowerCase()) ? raw : null;
}
