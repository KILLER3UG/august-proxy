/* ── Theme + text-size atoms (Phase 2.1 / 2.X) ─────────────────────── */
/* Persists to localStorage and applies class/attribute on <html>.      */
/* Synchronous apply functions are designed to be called BEFORE React   */
/* mounts in main.tsx to prevent FOUC.                                  */

import { atom } from 'nanostores';

export type ThemeMode = 'light' | 'dark' | 'system';
export type TextSize = 'compact' | 'default' | 'comfortable' | 'spacious';

const THEME_STORAGE_KEY = 'august.theme';
const TEXT_SIZE_STORAGE_KEY = 'august.textSize';

export const $themeMode = atom<ThemeMode>('dark');
export const $textSize = atom<TextSize>('default');

/* ── Theme mode ──────────────────────────────────────────────────── */

function resolveSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(mode: ThemeMode | null): void {
  const resolved: ThemeMode = mode && ['light', 'dark', 'system'].includes(mode) ? mode : 'dark';
  $themeMode.set(resolved);
  if (typeof document === 'undefined') return;
  const effective = resolved === 'system' ? resolveSystemTheme() : resolved;
  const root = document.documentElement;
  if (effective === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
  try {
    localStorage.setItem(THEME_STORAGE_KEY, resolved);
  } catch {
    /* localStorage may be unavailable (private mode); ignore */
  }
}

export function setThemeMode(mode: ThemeMode): void {
  applyTheme(mode);
}

/* ── Text size ───────────────────────────────────────────────────── */

export function applyTextSize(size: TextSize | null): void {
  const resolved: TextSize =
    size && ['compact', 'default', 'comfortable', 'spacious'].includes(size) ? size : 'default';
  $textSize.set(resolved);
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-text-size', resolved);
  try {
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, resolved);
  } catch {
    /* ignore */
  }
}

export function setTextSize(size: TextSize): void {
  applyTextSize(size);
}

/* ── Hydrate from localStorage on module load ────────────────────── */

export function hydrateTheme(): void {
  if (typeof window === 'undefined') return;
  let theme: string | null = null;
  let size: string | null = null;
  try {
    theme = localStorage.getItem(THEME_STORAGE_KEY);
    size = localStorage.getItem(TEXT_SIZE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  applyTheme(theme as ThemeMode | null);
  applyTextSize(size as TextSize | null);

  // Follow OS theme changes when mode is 'system'
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if ($themeMode.get() === 'system') applyTheme('system');
  };
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', onChange);
  } else if (typeof (mq as MediaQueryList & {
    addListener?: (cb: () => void) => void;
  }).addListener === 'function') {
    (mq as MediaQueryList & {
      addListener: (cb: () => void) => void;
    }).addListener(onChange);
  }
}
