/**
 * The single source of truth for keyboard shortcuts.
 *
 * This file exists because the reference modal was a hand-maintained list that
 * drifted: Ctrl+N had worked for months and was never in it (found 2026-10-04).
 * App.tsx dispatches the app-level bindings through `resolveShortcut` (each
 * carries an `action`); ShortcutsModal renders the same array, so a binding
 * cannot ship undocumented. Composer- and surface-local keys are listed here
 * too (their handlers stay where they are — this is the registry, not a
 * dispatcher for those).
 *
 * `combo` is the normalized lookup key: ctrl/⌘ + alt + shift + the physical key,
 * e.g. 'ctrl+k', 'ctrl+shift+space'. ⌘ is normalized onto `ctrl` (they are
 * interchangeable primary modifiers). `comboFor` powers the modal's "press a
 * key" search; `resolveShortcut` is the app-level matcher.
 */

/** What App.tsx does when an app-level shortcut fires. */
export type AppShortcutAction =
  | 'palette'
  | 'new-chat'
  | 'toggle-sidebar'
  | 'toggle-right-drawer'
  | 'settings'
  | 'shortcuts';

export interface ShortcutBinding {
  /** Display chips, left to right (e.g. ['Ctrl', 'K']). */
  keys: string[];
  label: string;
  /** Normalized combo for lookup; omit for plain keys. */
  combo?: string;
  /** Windows uses Ctrl where macOS uses ⌘; the modal swaps the first chip. */
  macPrimary?: boolean;
  /** App-level handler id; present on every binding App.tsx dispatches. */
  action?: AppShortcutAction;
  /** Keep firing while focus is inside an input/textarea (palette and pane
   *  toggles do; Ctrl+N and the punctuation keys do not). */
  allowWhileTyping?: boolean;
}

export interface ShortcutGroup {
  heading: string;
  items: ShortcutBinding[];
}

/** App-level bindings: the registry IS the dispatcher table (App.tsx calls
 *  `resolveShortcut` and switches on `action`), so a binding cannot ship
 *  unwired or undocumented. */
export const APP_SHORTCUTS: ShortcutBinding[] = [
  { keys: ['Ctrl', 'K'], label: 'Command palette', combo: 'ctrl+k', action: 'palette', allowWhileTyping: true },
  { keys: ['Ctrl', 'P'], label: 'Command palette (alias)', combo: 'ctrl+p', action: 'palette', allowWhileTyping: true },
  { keys: ['Ctrl', 'N'], label: 'New chat', combo: 'ctrl+n', action: 'new-chat' },
  { keys: ['Ctrl', 'B'], label: 'Toggle sidebar', combo: 'ctrl+b', action: 'toggle-sidebar', allowWhileTyping: true },
  { keys: ['Ctrl', 'J'], label: 'Toggle right panel', combo: 'ctrl+j', action: 'toggle-right-drawer', allowWhileTyping: true },
  { keys: [','], label: 'Settings', combo: ',', action: 'settings' },
  { keys: ['?'], label: 'Keyboard shortcuts', combo: '?', action: 'shortcuts' },
];

/** Everything the reference modal documents, grouped. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  { heading: 'Global', items: APP_SHORTCUTS },
  {
    heading: 'Composer',
    items: [
      { keys: ['Enter'], label: 'Send message' },
      { keys: ['Shift', 'Enter'], label: 'New line' },
      { keys: ['Ctrl', 'Enter'], label: 'Send (hard send)' },
      { keys: ['Ctrl', 'Shift', 'Space'], label: 'Focus composer from anywhere' },
      { keys: ['Ctrl', 'Shift', 'P'], label: 'Toggle live markdown preview' },
      { keys: ['↑', '↓'], label: 'Navigate @mention / command list' },
      { keys: ['Esc'], label: 'Stop the running turn · close popovers' },
    ],
  },
  {
    heading: 'Approval cards',
    items: [{ keys: ['1', '2', '3'], label: 'Choose permission option' }],
  },
  {
    heading: 'Git panel',
    items: [{ keys: ['Ctrl', 'Enter'], label: 'Commit' }],
  },
  {
    heading: 'Transcript',
    items: [
      { keys: ['Ctrl', 'F'], label: 'Find in conversation' },
      { keys: ['PageUp'], label: 'Release the follow-scroll (read older turns)' },
    ],
  },
];

/** Normalized combo string for a keyboard event: 'ctrl+shift+space', 'escape', ',' …
 *  ⌘ (metaKey) normalizes onto `ctrl`: the two are interchangeable primary
 *  modifiers (Ctrl chips render as ⌘ on macOS at display time). */
export function comboFor(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  // Shift counts when it is a MODIFIER (Ctrl+Shift+Space differs from
  // Ctrl+Space). When the key itself is the shifted PRINT of a punctuation
  // character ('?', '!', '+'), shift is already baked into the key, so it
  // would only add a redundant segment.
  const key = e.key.toLowerCase();
  const shiftedPrint = e.shiftKey && key.length === 1 && !/[a-z0-9 ]/.test(key);
  if (e.shiftKey && !shiftedPrint) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

/** The combo with its shift segment dropped (for '?' arriving as shift+/). */
function withoutShift(combo: string): string | undefined {
  return combo.includes('+shift+') ? combo.replace('+shift+', '+') : undefined;
}

/** The app-level binding a keyboard event fires, or undefined. */
export function resolveShortcut(e: KeyboardEvent): ShortcutBinding | undefined {
  const combo = comboFor(e);
  return APP_SHORTCUTS.find((b) => b.combo === combo);
}

/** Find the binding a typed combo belongs to (keystroke search). */
export function findByCombo(combo: string): ShortcutBinding | undefined {
  const all = SHORTCUT_GROUPS.flatMap((g) => g.items);
  const direct = all.find((b) => b.combo === combo);
  if (direct) return direct;
  // Guard the loose compare: combo-less (surface-local) bindings have
  // b.combo === undefined, and `undefined === undefined` would match them.
  const bare = withoutShift(combo);
  if (bare === undefined) return undefined;
  return all.find((b) => b.combo === bare);
}
