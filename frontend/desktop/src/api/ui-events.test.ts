/* Tests for UI events helper. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  dispatchUiAction,
  dispatchFocusComposer,
  dispatchInsertComposerText,
  onUiAction,
  asUiActionEvent,
  UI_ACTION_EVENT,
  FOCUS_COMPOSER_EVENT,
  INSERT_COMPOSER_TEXT_EVENT,
  type UiActionEvent,
} from './ui-events';

describe('ui-events dispatchers', () => {
  beforeEach(() => {
    // Clear any leftover listeners between tests
    window.dispatchEvent(new CustomEvent('test:reset'));
  });

  it('dispatchUiAction emits a CustomEvent with detail', () => {
    const handler = vi.fn();
    window.addEventListener(UI_ACTION_EVENT, handler as EventListener);

    dispatchUiAction({ action: 'navigate', target: '/settings/memory-knowledge' });
    expect(handler).toHaveBeenCalledTimes(1);
    const ev = handler.mock.calls[0][0] as CustomEvent<UiActionEvent>;
    expect(ev.detail.action).toBe('navigate');
    expect(ev.detail.target).toBe('/settings/memory-knowledge');
    window.removeEventListener(UI_ACTION_EVENT, handler as EventListener);
  });

  it('dispatchFocusComposer emits the focus event', () => {
    const handler = vi.fn();
    window.addEventListener(FOCUS_COMPOSER_EVENT, handler as EventListener);
    dispatchFocusComposer();
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(FOCUS_COMPOSER_EVENT, handler as EventListener);
  });

  it('dispatchInsertComposerText emits with text detail', () => {
    const handler = vi.fn();
    window.addEventListener(INSERT_COMPOSER_TEXT_EVENT, handler as EventListener);
    dispatchInsertComposerText('Hello world');
    expect(handler).toHaveBeenCalledTimes(1);
    const ev = handler.mock.calls[0][0] as CustomEvent<{ text: string }>;
    expect(ev.detail.text).toBe('Hello world');
    window.removeEventListener(INSERT_COMPOSER_TEXT_EVENT, handler as EventListener);
  });
});

describe('onUiAction subscriber', () => {
  it('receives only events with valid detail', () => {
    const handler = vi.fn();
    const unsubscribe = onUiAction(handler);

    dispatchUiAction({ action: 'set_guard_mode', target: 'full' });
    dispatchUiAction({ action: 'refresh', target: '' });
    // Junk event without detail should be ignored
    window.dispatchEvent(new CustomEvent(UI_ACTION_EVENT));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].action).toBe('set_guard_mode');
    expect(handler.mock.calls[1][0].action).toBe('refresh');

    unsubscribe();
    dispatchUiAction({ action: 'navigate', target: '/x' });
    expect(handler).toHaveBeenCalledTimes(2); // no more after unsubscribe
  });
});

describe('asUiActionEvent parser', () => {
  it('returns null for events without valid detail', () => {
    const event = new CustomEvent(UI_ACTION_EVENT);
    expect(asUiActionEvent(event)).toBeNull();
  });

  it('returns null for events with non-string action', () => {
    const event = new CustomEvent<unknown>(UI_ACTION_EVENT, { detail: { action: 123, target: '/x' } });
    expect(asUiActionEvent(event)).toBeNull();
  });

  it('returns null for events without target string', () => {
    const event = new CustomEvent<unknown>(UI_ACTION_EVENT, { detail: { action: 'navigate' } });
    expect(asUiActionEvent(event)).toBeNull();
  });

  it('returns parsed event for valid detail', () => {
    const event = new CustomEvent<UiActionEvent>(UI_ACTION_EVENT, {
      detail: { action: 'navigate', target: '/settings' },
    });
    expect(asUiActionEvent(event)).toEqual({ action: 'navigate', target: '/settings' });
  });
});
