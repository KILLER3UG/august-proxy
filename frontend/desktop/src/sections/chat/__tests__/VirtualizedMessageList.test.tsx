import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { ChatMessage } from '@/types/chat';
import { VirtualizedMessageList } from '../VirtualizedMessageList';

/* The transcript swaps DOM strategy at VIRTUALIZE_AFTER (40): under it a plain
 * flow map, at and over it absolutely-positioned rows inside a synthetic-height
 * container. Nothing asserts the two agree on geometry, so the swap can move
 * every message sideways and no test notices.
 *
 * These assert the CLASS contract rather than measured pixels, because jsdom
 * has no layout engine — every getBoundingClientRect() is 0, so a pixel
 * comparison here would pass for the wrong reason and rot silently.
 *
 * The subtle one: the virtualized row's own `px-4` is NOT double padding.
 * Absolutely positioned children lay out against the containing block's PADDING
 * box, so they ignore the parent's `px-4` — the row must carry its own inset
 * to land where the flow branch's content does. Delete it as "duplicated
 * padding" and every row jumps 16px left the moment a thread crosses 40. */

function messages(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
    blocks: [],
  })) as unknown as ChatMessage[];
}

/** A scroll parent the virtualizer can actually measure. jsdom reports 0 for
 *  every box, and a virtualizer with no viewport computes an empty range —
 *  which would make the >= 40 branch look like it rendered nothing. Note the
 *  library reads `offsetWidth`/`offsetHeight`, not getBoundingClientRect. */
function scrollParent() {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: 800, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 800, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true });
  el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, bottom: 800, right: 800, width: 800, height: 800, x: 0, y: 0 }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

async function renderList(n: number): Promise<HTMLElement> {
  const parent = scrollParent();
  const { container } = render(
    <VirtualizedMessageList
      messages={messages(n)}
      scrollParentRef={{ current: parent }}
      renderMessage={(m) => <div data-testid={`row-${m.id}`}>{m.content}</div>}
    />,
  );
  const list = container.querySelector('.august-message-list') as HTMLElement;
  if (n >= 40) {
    // The virtualizer measures its scroll element on mount, so the first
    // render has no items; wait for the window it computed.
    await waitFor(() => {
      expect(list.querySelectorAll('[data-index]').length).toBeGreaterThan(0);
    });
  }
  return list;
}

const rows = (list: HTMLElement) => list.querySelectorAll<HTMLElement>('[data-testid^="row-"]');
const hasClass = (el: Element | null, name: string) => !!el?.className.split(' ').includes(name);

describe('VirtualizedMessageList threshold', () => {
  it('mounts a plain flow map below the threshold and measured rows at it', async () => {
    const short = await renderList(39);
    expect(rows(short).length).toBe(39);
    // No data-index anywhere: the flow branch has no virtualizer at all.
    expect(short.querySelector('[data-index]')).toBeNull();

    const tall = await renderList(40);
    expect(tall.querySelector('[data-index]')).not.toBeNull();
    // The virtualized container reserves the scroll height up front. The
    // windowing itself is NOT asserted: jsdom measures every row at 0px, so
    // the range degenerates to "everything" here and any count would be an
    // artifact of the environment, not of the app.
    expect(tall.style.height).toMatch(/^\d+px$/);
  });

  it('the container declares the same horizontal padding on both branches', async () => {
    expect(hasClass(await renderList(39), 'px-4')).toBe(true);
    expect(hasClass(await renderList(40), 'px-4')).toBe(true);
  });

  it('the virtualized row carries its own inset because it escapes the padding', async () => {
    // The compensation is load-bearing: `absolute left-0 right-0` positions
    // against the PADDING box, so without this px-4 every row at >= 40
    // messages sits 16px left of where the same row sat at 39.
    const virtualRow = (await renderList(40)).querySelector('[data-index="0"]');
    expect(hasClass(virtualRow, 'px-4')).toBe(true);
    expect(hasClass(virtualRow, 'absolute')).toBe(true);
  });

  it('the flow branch leaves horizontal padding to the container alone', async () => {
    // The inverse of the case above — proving the two are a matched pair and
    // not two copies of the same inset.
    const firstRow = rows(await renderList(39))[0];
    expect(hasClass(firstRow, 'px-4')).toBe(false);
    expect(hasClass(firstRow, 'absolute')).toBe(false);
  });

  it('vertical rhythm is matched across the flip', async () => {
    // `space-y-5` is 20px; the virtualizer is configured with gap: 20.
    // Stating the pair here is what keeps a future edit from changing one.
    expect(hasClass(await renderList(39), 'space-y-5')).toBe(true);
    expect(hasClass(await renderList(40), 'space-y-5')).toBe(false);
  });

  it('search navigation is not handed a disabled virtualizer', async () => {
    const parent = scrollParent();
    const virtRef = { current: null as { scrollToIndex: (i: number) => void } | null };
    const props = {
      scrollParentRef: { current: parent } as never,
      renderMessage: (m: ChatMessage) => <div key={m.id}>{m.content}</div>,
      virtRef: virtRef as never,
    };
    const { rerender } = render(<VirtualizedMessageList messages={messages(39)} {...props} />);
    // Below the threshold the DOM fallback must own navigation.
    expect(virtRef.current).toBeNull();
    rerender(<VirtualizedMessageList messages={messages(40)} {...props} />);
    await waitFor(() => expect(virtRef.current).not.toBeNull());
  });
});