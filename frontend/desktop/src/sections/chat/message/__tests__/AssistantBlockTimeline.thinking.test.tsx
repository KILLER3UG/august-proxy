/* ── AssistantBlockTimeline live thinking items (Bug 4) ──────────────────
 * The working indicator used to pin the same first-80-char snippet for the
 * whole turn; thinking now publishes one item per completed sentence with
 * the in-flight tail as the newest (running) line.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AssistantBlockTimeline } from '../AssistantBlockTimeline';
import { useLiveActivityStore, clearLiveActivity } from '@/store/liveActivity';
import type { ChatMessage, MessageBlock } from '@/types/chat';

function messageWithThinking(content: string): ChatMessage {
  return {
    id: 'msg_think_live',
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
    blocks: [{ id: 'th1', type: 'thinking', content } satisfies MessageBlock],
  };
}

function renderTimeline(content: string, streaming: boolean) {
  const message = messageWithThinking(content);
  return render(
    <MemoryRouter>
      <AssistantBlockTimeline
        displayBlocks={message.blocks as MessageBlock[]}
        message={message}
        isLast
        streaming={streaming}
        showPendingThinking={false}
      />
    </MemoryRouter>,
  );
}

function publishedItems() {
  const { bySession } = useLiveActivityStore.getState();
  const entry = Object.values(bySession).find((e) => e.items.length > 0);
  return entry?.items ?? [];
}

describe('AssistantBlockTimeline live thinking sentences', () => {
  beforeEach(() => {
    clearLiveActivity();
  });

  it('publishes one done item per completed sentence plus a running tail', () => {
    act(() => {
      renderTimeline(
        'First idea lands. Second idea follows. Third is still forming',
        true,
      );
    });
    const items = publishedItems();
    const thinking = items.filter((i) => i.kind === 'thinking');
    expect(thinking.map((i) => i.detail)).toEqual([
      'First idea lands',
      'Second idea follows',
      'Third is still forming',
    ]);
    expect(thinking[0].status).toBe('done');
    expect(thinking[1].status).toBe('done');
    // In-flight tail rides as the newest running line.
    expect(thinking[2].status).toBe('running');
  });

  it('treats a thought ending in punctuation as fully complete', () => {
    act(() => {
      renderTimeline('Only one sentence here.', true);
    });
    const thinking = publishedItems().filter((i) => i.kind === 'thinking');
    expect(thinking).toHaveLength(1);
    // Last item is promoted to running while the turn still streams.
    expect(thinking[0].detail).toBe('Only one sentence here.');
    expect(thinking[0].status).toBe('running');
  });

  it('caps the sentence backlog to the newest six', () => {
    act(() => {
      renderTimeline(
        'One. Two. Three. Four. Five. Six. Seven. Eight is in flight',
        true,
      );
    });
    const thinking = publishedItems().filter((i) => i.kind === 'thinking');
    // 7 completed sentences cap to the last 6, plus the running tail.
    expect(thinking).toHaveLength(7);
    expect(thinking[0].detail).toBe('Two');
    expect(thinking[thinking.length - 1].detail).toBe('Eight is in flight');
    expect(thinking[thinking.length - 1].status).toBe('running');
  });
});
