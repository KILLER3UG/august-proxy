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
  | 'export_conversation'
  | 'export_conversation_pdf'
  | 'copy_conversation'
  | 'stop_chat';

export interface UiActionEvent {
  id?: string;
  action: UiAction;
  target: string;
  payload?: Record<string, unknown>;
}

export const UI_ACTION_EVENT = 'august:ui-action';
export const FOCUS_COMPOSER_EVENT = 'august:focus-composer';
export const INSERT_COMPOSER_TEXT_EVENT = 'august:insert-composer-text';

export interface ComposerTextSeed {
  text: string;
  /** A card seed: fill an empty composer exactly, otherwise append. */
  replace?: boolean;
}

let pendingComposerSeed: ComposerTextSeed | null = null;

export function dispatchUiAction(detail: UiActionEvent): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(UI_ACTION_EVENT, { detail }));
}

export function dispatchFocusComposer(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT));
}

/** Seed the composer. The event reaches a MOUNTED composer immediately; the
 *  module-level handoff covers the other case — a seed fired while navigating
 *  to a chat whose composer mounts after the event has passed (Charts → New
 *  chart → a fresh thread). The composer consumes it on mount. */
export function dispatchInsertComposerText(text: string, options: { replace?: boolean } = {}): void {
  if (typeof window === 'undefined') return;
  const seed: ComposerTextSeed = { text, replace: options.replace };
  pendingComposerSeed = seed;
  window.dispatchEvent(new CustomEvent(INSERT_COMPOSER_TEXT_EVENT, { detail: seed }));
}

export function takePendingComposerInsert(): ComposerTextSeed | null {
  const seed = pendingComposerSeed;
  pendingComposerSeed = null;
  return seed;
}

export function clearPendingComposerInsert(): void {
  pendingComposerSeed = null;
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

/**
 * Actions whose only listeners live inside the chat surface
 * (`useChatUiActions`, `ChatThreadComposer`). The command palette is mounted at
 * app level and `ChatLayout` wraps `/settings`, `/board`, `/runs`, `/automations`
 * and `/history` too — so on those routes these actions dispatched a
 * CustomEvent into nothing, with no toast and no explanation, which reads as
 * "August lost export" rather than "you are not looking at a conversation".
 */
const CHAT_SCOPED_ACTIONS: ReadonlySet<UiAction> = new Set<UiAction>([
  'undo_last_turn',
  'stop_chat',
  'branch_session',
  'compact_now',
  'export_conversation',
  'export_conversation_pdf',
  'copy_conversation',
]);

let chatSurfaceClaims = 0;

export function isChatScopedAction(action: UiAction): boolean {
  return CHAT_SCOPED_ACTIONS.has(action);
}

/** Register the chat surface as mounted. Refcounted, because more than one
 *  component claims it and React may mount a subtree twice. */
export function claimChatSurface(): () => void {
  chatSurfaceClaims += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    chatSurfaceClaims = Math.max(0, chatSurfaceClaims - 1);
  };
}

export function hasChatSurface(): boolean {
  return chatSurfaceClaims > 0;
}
