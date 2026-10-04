import { describe, expect, it } from 'vitest';
import {
  APP_SHORTCUTS,
  SHORTCUT_GROUPS,
  comboFor,
  findByCombo,
  resolveShortcut,
} from '../lib/shortcuts';

/**
 * The drift guard. The hand-written reference modal missed Ctrl+N for a year;
 * App.tsx now dispatches through `resolveShortcut` and switches on the
 * binding's `action`, while ShortcutsModal renders the same `APP_SHORTCUTS`
 * array — so a binding cannot ship unwired or undocumented.
 */
function eventOf(over: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  } as KeyboardEvent;
}

describe('shortcut registry', () => {
  it('every app binding carries a handler action', () => {
    for (const b of APP_SHORTCUTS) {
      expect(b.action, `"${b.label}" (${b.combo}) has no action to dispatch`).toBeTruthy();
    }
    // The other direction: no two bindings claim the same combo.
    const combos = APP_SHORTCUTS.map((b) => b.combo);
    expect(new Set(combos).size).toBe(combos.length);
  });

  it('resolveShortcut dispatches each app binding from a synthetic event', () => {
    const cases: Array<[KeyboardEvent, string]> = [
      [eventOf({ ctrlKey: true, key: 'k' }), 'palette'],
      [eventOf({ ctrlKey: true, key: 'p' }), 'palette'],
      [eventOf({ ctrlKey: true, key: 'n' }), 'new-chat'],
      [eventOf({ ctrlKey: true, key: 'b' }), 'toggle-sidebar'],
      [eventOf({ ctrlKey: true, key: 'j' }), 'toggle-right-drawer'],
      [eventOf({ key: ',' }), 'settings'],
      [eventOf({ key: '?', shiftKey: true }), 'shortcuts'],
    ];
    for (const [e, action] of cases) {
      expect(resolveShortcut(e)?.action, `combo ${comboFor(e)}`).toBe(action);
    }
    // ⌘ and Ctrl are the same primary modifier.
    expect(resolveShortcut(eventOf({ metaKey: true, key: 'k' }))?.action).toBe('palette');
    // Modified variants stay unclaimed.
    expect(resolveShortcut(eventOf({ ctrlKey: true, shiftKey: true, key: 'k' }))).toBeUndefined();
    expect(resolveShortcut(eventOf({ ctrlKey: true, altKey: true, key: 'n' }))).toBeUndefined();
    expect(resolveShortcut(eventOf({ key: 'Escape' }))).toBeUndefined();
  });

  it('typing-target policy is explicit per binding', () => {
    // Palette + pane toggles fire from inside inputs; the rest do not.
    const byCombo = new Map(APP_SHORTCUTS.map((b) => [b.combo, b]));
    expect(byCombo.get('ctrl+k')?.allowWhileTyping).toBe(true);
    expect(byCombo.get('ctrl+b')?.allowWhileTyping).toBe(true);
    expect(byCombo.get('ctrl+j')?.allowWhileTyping).toBe(true);
    expect(byCombo.get('ctrl+n')?.allowWhileTyping).toBeUndefined();
    expect(byCombo.get('?')?.allowWhileTyping).toBeUndefined();
    expect(byCombo.get(',')?.allowWhileTyping).toBeUndefined();
  });

  it('has no duplicate bindings inside a group', () => {
    for (const g of SHORTCUT_GROUPS) {
      const combos = g.items.map((i) => i.combo).filter(Boolean);
      expect(new Set(combos).size, `duplicate combo in ${g.heading}`).toBe(combos.length);
    }
  });

  it('keystroke lookup finds bindings and normalizes modifiers', () => {
    // Synthesize the events a browser would fire for Ctrl+K / Escape.
    const ctrlK = eventOf({ ctrlKey: true, key: 'k' });
    expect(findByCombo(comboFor(ctrlK))?.label).toBe('Command palette');

    const esc = eventOf({ key: 'Escape' });
    expect(findByCombo(comboFor(esc))).toBeUndefined(); // Esc is surface-local, not app-level

    const comma = eventOf({ key: ',' });
    expect(findByCombo(comboFor(comma))?.label).toBe('Settings');

    const ctrlShiftSpace = eventOf({ ctrlKey: true, shiftKey: true, key: ' ' });
    expect(comboFor(ctrlShiftSpace)).toBe('ctrl+shift+ ');
    // A shifted punctuation key ( '?' arrives as shift+/ ) matches the
    // shift-insensitive lookup.
    const question = eventOf({ key: '?', shiftKey: true });
    expect(findByCombo(comboFor(question))?.label).toBe('Keyboard shortcuts');
  });

  it('every group heading is unique and every item has a label', () => {
    const headings = SHORTCUT_GROUPS.map((g) => g.heading);
    expect(new Set(headings).size).toBe(headings.length);
    for (const g of SHORTCUT_GROUPS) {
      for (const item of g.items) expect(item.label.length).toBeGreaterThan(0);
    }
  });
});