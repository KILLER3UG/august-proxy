import { describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { ConfirmDialog } from '../ConfirmDialog';
import { PromptDialog } from '../PromptDialog';

/**
 * The live-found regression (2026-10-04): an enclosing surface listens on
 * window — exactly like WorkspaceShell.md does for Settings — and a nested
 * dialog's Escape double-fired. A window-bubble listener with
 * `stopPropagation()` cannot stop another listener on the same target
 * (window), so one Escape cancelled the dialog AND closed Settings.
 *
 * The dialogs now consume Escape on document capture via BackdropEscape.
 * These tests pin the propagation contract, not just "onCancel was called".
 */
function EnclosingLayer({ onEscape }: { onEscape: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEscape]);
  return null;
}

describe('one Escape closes one layer', () => {
  it('a nested ConfirmDialog consumes Escape and the enclosing layer stays open', () => {
    const enclosing = vi.fn();
    const cancel = vi.fn();
    render(
      <>
        <EnclosingLayer onEscape={enclosing} />
        <ConfirmDialog
          open
          title="Delete skill?"
          message="Delete it?"
          onConfirm={() => {}}
          onCancel={cancel}
        />
      </>,
    );

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(enclosing).not.toHaveBeenCalled();
  });

  it('a nested PromptDialog consumes Escape and the enclosing layer stays open', () => {
    const enclosing = vi.fn();
    const cancel = vi.fn();
    render(
      <>
        <EnclosingLayer onEscape={enclosing} />
        <PromptDialog
          open
          title="Rename chat"
          label="Chat name"
          onSubmit={() => {}}
          onCancel={cancel}
        />
      </>,
    );

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(enclosing).not.toHaveBeenCalled();
  });

  it('a closed dialog leaves Escape to the enclosing layer', () => {
    const enclosing = vi.fn();
    render(
      <>
        <EnclosingLayer onEscape={enclosing} />
        <ConfirmDialog
          open={false}
          title="Delete skill?"
          message="Delete it?"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </>,
    );

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(enclosing).toHaveBeenCalledTimes(1);
  });
});
