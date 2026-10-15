/* ── CompactionNoticeCard ───────────────────────────────────────────────
 * The expanded detail states how much of the transcript was kept verbatim.
 * Two frames exist: one that knows its split and one (the reactive overflow
 * rescue) that does not. The second must not claim "first 0 and last 0".
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CompactionNoticeCard } from '../message/CompactionNoticeCard';

const base = {
  compressedCount: 23,
  originalTokens: 30258,
  compressedTokens: 12436,
};

function openDetail(info: typeof base & { headCount?: number; tailCount?: number }) {
  const { container } = render(<CompactionNoticeCard info={info} />);
  const trigger = container.querySelector('button');
  expect(trigger, 'the card is a disclosure row with a button trigger').not.toBeNull();
  fireEvent.click(trigger as HTMLElement);
  return container;
}

describe('CompactionNoticeCard', () => {
  it('states the split it was given', () => {
    const container = openDetail({ ...base, headCount: 4, tailCount: 9 });
    expect(container.textContent).toContain('first 4');
    expect(container.textContent).toContain('last 9');
  });

  it('omits the split clause when the frame did not report one', () => {
    const container = openDetail({ ...base });
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/first 0/);
    expect(text).not.toMatch(/last 0/);
    expect(text).toContain('Summarized 23 messages in the middle');
  });

  it('names the message count in the collapsed label', () => {
    render(<CompactionNoticeCard info={{ ...base, headCount: 4, tailCount: 9 }} />);
    expect(screen.getByText(/summarized 23 messages/i)).toBeInTheDocument();
  });
});

/* The frame reaches the card by two paths: the live SSE reader, and a persisted
 * transcript row re-read through MessageBubble's `context` object. The second one
 * had its own `?? 0` and only the real app showed it, so it is asserted here. */
import { MessageBubble } from '../MessageBubble';

describe('compaction notice via MessageBubble', () => {
  it('keeps an absent split absent on the replayed-transcript path', () => {
    const { container } = render(
      <MessageBubble
        message={{
          id: 'cp-replay',
          role: 'assistant',
          content: '',
          kind: 'compaction-notice',
          timestamp: '2026-10-15T10:00:00Z',
          context: { compressedCount: 12, originalTokens: 400, compressedTokens: 90 },
        }}
      />,
    );
    const trigger = container.querySelector('button');
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger as HTMLElement);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/first 0/);
    expect(text).toContain('Summarized 12 messages in the middle');
  });
});
