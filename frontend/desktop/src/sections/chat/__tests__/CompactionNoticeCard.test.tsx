/* ── CompactionNoticeCard ───────────────────────────────────────────────
 * The expanded detail states how much of the transcript was kept verbatim.
 * Two frames exist: one that knows its split and one (the reactive overflow
 * rescue) that does not. The second must not claim "first 0 and last 0".
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CompactionNoticeCard, buildCompactionNoticeMessage, type CompactionNoticeInfo } from '../message/CompactionNoticeCard';

const base = {
  compressedCount: 23,
  originalTokens: 30258,
  compressedTokens: 12436,
};

function openDetail(info: CompactionNoticeInfo) {
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

  /* `relief` is emitted on every pre-turn and budget frame but the reader used to
   * drop it, so a rotate — a route that keeps no head and replays the opening ask —
   * rendered the same "Kept the first 0" sentence as a compact-in-place. */
  it('describes the rotate route by what it actually kept', () => {
    const container = openDetail({
      ...base,
      relief: 'rotate',
      headCount: 0,
      tailCount: 9,
      replayedCount: 1,
      compressedCount: 31,
    });
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/first 0/);
    expect(text).toContain('kept the last 9 messages');
    expect(text).toContain('replayed the opening ask');
    // The `contextWindow` clause is appended after this sentence, so it must not
    // read "live only in the archive to stay within 40k context" — a clause the
    // shared archive sentence below already states. Caught by reading the
    // assembled text in the running app, not from the component's own string.
    expect(text).not.toMatch(/archive to stay within/);
  });

  it('labels the route in the collapsed row, not only in the detail', () => {
    render(<CompactionNoticeCard info={{ ...base, relief: 'rotate', tailCount: 9, compressedCount: 31 }} />);
    expect(screen.getByText(/rotated onto its handoff note/i)).toBeInTheDocument();
    expect(screen.queryByText(/summarized 23 messages/i)).not.toBeInTheDocument();
  });

  it('falls back to the count alone when rotate reported no split', () => {
    const container = openDetail({ ...base, relief: 'rotate' });
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/first 0/);
    expect(text).not.toMatch(/last 0/);
    expect(text).toContain('Rotated onto the handoff note; summarized 23 messages');
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

  it('survives the persist-and-replay round trip with its route intact', () => {
    // `buildCompactionNoticeMessage` re-lists the context field by field, so a
    // field named on the info but not in that rebuild is write-only: the live
    // frame looks right and every reloaded transcript loses it.
    const msg = buildCompactionNoticeMessage(
      { ...base, relief: 'rotate', headCount: 0, tailCount: 9, replayedCount: 2, compressedCount: 31 },
      77,
    );
    const { container } = render(<MessageBubble message={msg as never} />);
    fireEvent.click(container.querySelector('button') as HTMLElement);
    const text = container.textContent ?? '';
    expect(text).toContain('rotated onto its handoff note');
    expect(text).toContain('kept the last 9 messages');
    expect(text).toContain('replayed the opening asks');
    expect(text).not.toMatch(/first 0/);
  });
});
