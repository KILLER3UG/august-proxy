export const STORAGE_KEY = 'august-brain-popup-state';
export const DEFAULT_WIDTH = 520;
export const DEFAULT_HEIGHT = 520;
export const MIN_WIDTH = 380;
export const MIN_HEIGHT = 320;
export const MARGIN = 16; // padding from viewport edges

export type TabKey = 'activity' | 'learning' | 'ops' | 'health';

export interface PopupState {
  width: number;
  height: number;
  x: number; // left in viewport coords
  y: number; // top in viewport coords
}

/** Default: anchored top-right, just under the title bar (h-12 + 4px). */
export function defaultState(): PopupState {
  return {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    x:
      typeof window !== 'undefined'
        ? Math.max(MARGIN, window.innerWidth - DEFAULT_WIDTH - MARGIN)
        : 200,
    y: 64, // title bar (~48px) + 16px gap
  };
}

/** Keep popup fully on-screen with min size when viewport or stored geom changes. */
export function clampState(s: PopupState): PopupState {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const w = Math.max(MIN_WIDTH, Math.min(s.width, vw - MARGIN * 2));
  const h = Math.max(MIN_HEIGHT, Math.min(s.height, vh - MARGIN * 2));
  const x = Math.max(MARGIN, Math.min(s.x, vw - w - MARGIN));
  const y = Math.max(MARGIN, Math.min(s.y, vh - h - MARGIN));
  return { width: w, height: h, x, y };
}

/** Load last popup position/size from localStorage, or fall back to default. */
export function loadState(): PopupState {
  if (typeof window === 'undefined') return defaultState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PopupState>;
      if (
        typeof parsed.width === 'number' &&
        typeof parsed.height === 'number' &&
        typeof parsed.x === 'number' &&
        typeof parsed.y === 'number'
      ) {
        return clampState(parsed as PopupState);
      }
    }
  } catch {
    /* fall through */
  }
  return defaultState();
}
