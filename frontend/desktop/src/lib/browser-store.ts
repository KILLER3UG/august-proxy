/* ── Browser automation store (Zustand pilot — Phase 4 B18) ─────── */
/* Holds the live state for the headless browser drawer section: the   */
/* latest screenshot + cursor overlay + an action log. Fed by the      */
/* `browserAction` SSE event emitted from workbench._execute_tool.    */
/*                                                                    */
/* B18 pilot: first nanostores → Zustand migration. Other stores still */
/* use nanostores; see docs/REFACTOR_PROGRESS.md for remaining list.  */

import { create } from 'zustand';

/** A single browser action received from the backend SSE stream. */
export interface BrowserAction {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  url?: string;
  title?: string;
  /** Target element bbox in page coordinates — the frontend overlays a cursor here. */
  target?: { x: number; y: number; width: number; height: number } | null;
  /** Screenshot metadata returned by the handler. */
  screenshot?: { path: string; width: number; height: number } | null;
  typed?: string;
  selected?: string;
  scrolled?: string;
  status: 'success' | 'error';
  /** Client-side timestamp (ms) for log ordering. */
  ts: number;
}

export interface BrowserDrawerState {
  /** Most recent action — drives the live screenshot + cursor. */
  latest: BrowserAction | null;
  /** Rolling action log (newest first), capped at MAX_LOG. */
  log: BrowserAction[];
  /** Current page title (from the latest action). */
  title: string | null;
  /** Current page URL (from the latest action). */
  url: string | null;
}

const MAX_LOG = 50;

const initialState: BrowserDrawerState = {
  latest: null,
  log: [],
  title: null,
  url: null,
};

/** Zustand store for the browser drawer. Prefer the hook in React components. */
export const useBrowserDrawerStore = create<BrowserDrawerState>(() => ({
  ...initialState,
}));

/** Append a browser action from the SSE stream and update live state. */
export function pushBrowserAction(action: BrowserAction): void {
  const prev = useBrowserDrawerStore.getState();
  useBrowserDrawerStore.setState({
    latest: action,
    log: [action, ...prev.log].slice(0, MAX_LOG),
    title: action.title ?? prev.title,
    url: action.url ?? prev.url,
  });
}

/** Reset the store (e.g. when the workbench session changes). */
export function clearBrowserDrawer(): void {
  useBrowserDrawerStore.setState({ ...initialState });
}

/** Build the screenshot URL for an <img src> given an absolute path. */
export function screenshotUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return `/api/browser/screenshot?path=${encodeURIComponent(path)}`;
}
