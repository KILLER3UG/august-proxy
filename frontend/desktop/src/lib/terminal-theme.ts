/* xterm.js needs concrete color strings at terminal creation, so the
 * sunken-chrome tokens are resolved from the CSS variables here. A
 * terminal keeps the colors it was created with until recreated —
 * acceptable, since the chrome around it re-themes live. */
export function terminalTheme(): {
  background: string;
  foreground: string;
  cursor: string;
} {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--dt-surface-sunken', '#121212'),
    foreground: v('--dt-code-surface-fg', '#d4d4d4'),
    cursor: v('--dt-code-surface-fg', '#d4d4d4'),
  };
}
