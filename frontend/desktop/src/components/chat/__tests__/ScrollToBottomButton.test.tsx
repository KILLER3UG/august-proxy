/* ── ScrollToBottomButton ────────────────────────────────────────────────
 * Renders nothing when the transcript is already at the bottom, a round
 * icon otherwise, and the "New content" pill variant when the user is
 * scrolled up with fresh tokens.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScrollToBottomButton } from '../ScrollToBottomButton';

describe('ScrollToBottomButton', () => {
  it('renders nothing when not scrolled from the bottom', () => {
    const { container } = render(
      <ScrollToBottomButton visible={false} onClick={() => {}} showNewContentPill={false} />,
    );
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders the round icon button with the scroll-to-bottom label', () => {
    render(
      <ScrollToBottomButton visible onClick={() => {}} showNewContentPill={false} />,
    );
    const button = screen.getByLabelText('Scroll to bottom');
    expect(button).toBeTruthy();
    expect(button.textContent).toBe('');
  });

  it('renders the new-content pill when the user is scrolled up', () => {
    render(
      <ScrollToBottomButton visible onClick={() => {}} showNewContentPill />,
    );
    const button = screen.getByLabelText('Jump to new content');
    expect(button.textContent).toContain('New content');
  });

  it('calls onClick when pressed', () => {
    const onClick = vi.fn();
    render(<ScrollToBottomButton visible onClick={onClick} showNewContentPill={false} />);
    screen.getByLabelText('Scroll to bottom').click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
