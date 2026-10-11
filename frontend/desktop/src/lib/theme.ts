/* ── Theme + text-size store (Zustand — Phase 4 B18) ───────────────── */
/* Persists to localStorage and applies class/attribute on <html>.      */
/* Synchronous apply functions are designed to be called BEFORE React   */
/* mounts in main.tsx to prevent FOUC.                                  */

import { create } from 'zustand';

export type ThemeMode = 'light' | 'dark' | 'system';
export type TextSize = 'compact' | 'default' | 'comfortable' | 'spacious';
export type SurfaceFontKey = 'interface' | 'chat' | 'input' | 'code';
export type SurfaceFontSizes = Record<SurfaceFontKey, number>;

const THEME_STORAGE_KEY = 'august.theme';
const TEXT_SIZE_STORAGE_KEY = 'august.textSize';
const SURFACE_FONT_STORAGE_KEY = 'august.surfaceFontSizes';
const DEFAULT_SURFACE_FONT_SIZES: SurfaceFontSizes = { interface: 15, chat: 16, input: 16, code: 14 };

interface ThemeState {
  mode: ThemeMode;
  textSize: TextSize;
  surfaceFontSizes: SurfaceFontSizes;
}

export const useThemeStore = create<ThemeState>(() => ({
  mode: 'dark',
  textSize: 'default',
  surfaceFontSizes: DEFAULT_SURFACE_FONT_SIZES,
}));

/** Nanostores-shaped shim for imperative get/set/subscribe callers. */
export const $themeMode = {
  get: (): ThemeMode => useThemeStore.getState().mode,
  set: (mode: ThemeMode): void => {
    useThemeStore.setState({ mode });
  },
  subscribe: (listener: (mode: ThemeMode) => void): (() => void) => {
    listener(useThemeStore.getState().mode);
    return useThemeStore.subscribe((s) => listener(s.mode));
  },
};

export const $textSize = {
  get: (): TextSize => useThemeStore.getState().textSize,
  set: (textSize: TextSize): void => {
    useThemeStore.setState({ textSize });
  },
  subscribe: (listener: (size: TextSize) => void): (() => void) => {
    listener(useThemeStore.getState().textSize);
    return useThemeStore.subscribe((s) => listener(s.textSize));
  },
};

/* ── Theme mode ──────────────────────────────────────────────────── */

function resolveSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(mode: ThemeMode | null): void {
  const resolved: ThemeMode = mode && ['light', 'dark', 'system'].includes(mode) ? mode : 'dark';
  useThemeStore.setState({ mode: resolved });
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
  useThemeStore.setState({ textSize: resolved });
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

export function applySurfaceFontSizes(raw: Partial<SurfaceFontSizes> | null): void {
  const next = { ...DEFAULT_SURFACE_FONT_SIZES };
  for (const key of Object.keys(next) as SurfaceFontKey[]) {
    const value = Number(raw?.[key]);
    if (Number.isFinite(value)) next[key] = Math.max(12, Math.min(22, Math.round(value)));
  }
  useThemeStore.setState({ surfaceFontSizes: next });
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.style.setProperty('--font-ui', `${next.interface}px`);
    root.style.setProperty('--font-chat', `${next.chat}px`);
    root.style.setProperty('--font-input', `${next.input}px`);
    root.style.setProperty('--font-code', `${next.code}px`);
  }
  try { localStorage.setItem(SURFACE_FONT_STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
}

export function setSurfaceFontSize(key: SurfaceFontKey, size: number): void {
  applySurfaceFontSizes({ ...useThemeStore.getState().surfaceFontSizes, [key]: size });
}

/* ── Hydrate from localStorage on module load ────────────────────── */

export function hydrateTheme(): void {
  if (typeof window === 'undefined') return;
  let theme: string | null = null;
  let size: string | null = null;
  let fontSizes: Partial<SurfaceFontSizes> | null = null;
  try {
    theme = localStorage.getItem(THEME_STORAGE_KEY);
    size = localStorage.getItem(TEXT_SIZE_STORAGE_KEY);
    const rawFonts = localStorage.getItem(SURFACE_FONT_STORAGE_KEY);
    fontSizes = rawFonts ? JSON.parse(rawFonts) as Partial<SurfaceFontSizes> : null;
  } catch {
    /* ignore */
  }
  applyTheme(theme as ThemeMode | null);
  applyTextSize(size as TextSize | null);
  applySurfaceFontSizes(fontSizes);

  // Follow OS theme changes when mode is 'system'
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (useThemeStore.getState().mode === 'system') applyTheme('system');
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
