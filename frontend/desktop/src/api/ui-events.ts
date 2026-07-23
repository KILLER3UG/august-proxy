/* ── UI events — typed wrappers for august:ui-action CustomEvents ── */
/* Frontend-only CustomEvents (window.dispatchEvent). The workbench/layout
 * listens for navigate, drawer, guard mode, composer focus, etc.
 */

export type UiAction =
  | 'navigate'
  | 'open_drawer'
  | 'close_drawer'
  | 'set_drawer_section'
  | 'set_guard_mode'
  | 'refresh'
  | 'focus_composer'
  | 'insert_composer_text'
  | 'undo_last_turn'
  | 'compact_now'
  | 'branch_session'
  | 'export_conversation';

export interface UiActionEvent {
  id?: string;
  action: UiAction;
  target: string;
  payload?: Record<string, unknown>;
}

export const UI_ACTION_EVENT = 'august:ui-action';
export const FOCUS_COMPOSER_EVENT = 'august:focus-composer';
export const INSERT_COMPOSER_TEXT_EVENT = 'august:insert-composer-text';

export function dispatchUiAction(detail: UiActionEvent): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(UI_ACTION_EVENT, { detail }));
}

export function dispatchFocusComposer(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT));
}

export function dispatchInsertComposerText(text: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(INSERT_COMPOSER_TEXT_EVENT, { detail: { text } }));
}

/**
 * Subscribe to UiActionEvents dispatched on window.
 * Returns an unsubscribe function.
 */
export function onUiAction(handler: (e: UiActionEvent) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    const detail = asUiActionEvent(event);
    if (detail) handler(detail);
  };
  window.addEventListener(UI_ACTION_EVENT, listener);
  return () => window.removeEventListener(UI_ACTION_EVENT, listener);
}

/**
 * Parse a UiActionEvent from a CustomEvent of unknown origin.
 * Returns null if the event is not a UiActionEvent.
 */
export function asUiActionEvent(event: Event): UiActionEvent | null {
  const ce = event as CustomEvent<UiActionEvent>;
  if (!ce.detail || typeof ce.detail !== 'object') return null;
  if (typeof ce.detail.action !== 'string' || typeof ce.detail.target !== 'string') return null;
  return ce.detail;
}
