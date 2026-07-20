import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AssistantBlockTimeline } from '../AssistantBlockTimeline';
import type { ChatMessage, MessageBlock } from '@/types/chat';

vi.mock('@/store/liveActivity', () => ({
  clearLiveActivity: vi.fn(),
  publishLiveActivity: vi.fn(),
}));

function makeMessage(partial?: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'msg_1',
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
    ...partial,
  };
}

function makeToolBlock(
  id: string,
  name: string,
  status: 'running' | 'done' | 'error',
  extras?: Partial<NonNullable<MessageBlock['tool']>>,
): MessageBlock {
  return {
    id: `block_${id}`,
    type: 'toolCall',
    tool: {
      id,
      name,
      status,
      summary: extras?.summary ?? (status === 'done' ? '{"ok":true}' : undefined),
      ...extras,
    },
  };
}

function renderTimeline(
  displayBlocks: MessageBlock[],
  opts?: {
    streaming?: boolean;
    isLast?: boolean;
    showPendingThinking?: boolean;
  },
) {
  return render(
    <MemoryRouter initialEntries={['/session/sess_test']}>
      <AssistantBlockTimeline
        displayBlocks={displayBlocks}
        message={makeMessage()}
        isLast={opts?.isLast ?? true}
        streaming={opts?.streaming ?? false}
        showPendingThinking={opts?.showPendingThinking ?? false}
      />
    </MemoryRouter>,
  );
}

function expandActivitySummary() {
  const pack = document.querySelector('[data-slot="activity-summary"]');
  expect(pack).toBeTruthy();
  if (pack?.getAttribute('data-expanded') === 'false') {
    const header = pack.querySelector('button.activity-summary-header');
    expect(header).toBeTruthy();
    fireEvent.click(header!);
  }
  expect(
    document.querySelector('[data-slot="activity-summary"]'),
  ).toHaveAttribute('data-expanded', 'true');
}

describe('AssistantBlockTimeline process UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('collapses process pack once a final response exists', () => {
    renderTimeline([
      {
        id: 't1',
        type: 'thinking',
        content: 'Considering the clock.',
      },
      makeToolBlock('tool_a', 'system_info', 'done', {
        summary: '{"time":"12:00"}',
      }),
      {
        id: 'f1',
        type: 'finalOutput',
        content: 'It is noon.',
      },
    ]);

    const pack = document.querySelector('[data-slot="activity-summary"]');
    expect(pack).toHaveAttribute('data-expanded', 'false');
    expect(document.querySelector('[data-slot="thought-step"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /system info/i })).toBeNull();

    expandActivitySummary();
    expect(document.querySelector('[data-slot="thought-step"]')).toBeTruthy();
    expect(document.querySelector('.process-thought-prose')).toBeTruthy();
    expect(document.querySelector('.process-thought-stem')).toBeTruthy();
    expect(screen.getByRole('button', { name: /system info/i })).toBeTruthy();
  });

  it('keeps thinking pack open while streaming before final output', () => {
    renderTimeline(
      [
        {
          id: 't1',
          type: 'thinking',
          content: 'Still thinking…',
        },
      ],
      { streaming: true, isLast: true },
    );

    const pack = document.querySelector('[data-slot="activity-summary"]');
    expect(pack).toHaveAttribute('data-expanded', 'true');
    expect(document.querySelector('[data-slot="thought-step"]')).toBeTruthy();
  });

  it('keeps settled tool-only process pack collapsed to a summary line', () => {
    renderTimeline([
      makeToolBlock('tool_a', 'system_info', 'done', {
        summary: '{"time":"12:00"}',
      }),
      {
        id: 'f1',
        type: 'finalOutput',
        content: 'It is noon.',
      },
    ]);

    const pack = document.querySelector('[data-slot="activity-summary"]');
    expect(pack).toHaveAttribute('data-expanded', 'false');
    expect(screen.queryByRole('button', { name: /system info/i })).toBeNull();
    expect(document.querySelector('[data-slot="thought-step"]')).toBeNull();
  });

  it('collapses done tools by default and expands to reveal response', () => {
    renderTimeline([
      {
        id: 't1',
        type: 'thinking',
        content: 'Considering the clock.',
      },
      makeToolBlock('tool_a', 'system_info', 'done', {
        summary: '{"time":"12:00"}',
      }),
      {
        id: 'f1',
        type: 'finalOutput',
        content: 'It is noon.',
      },
    ]);

    expandActivitySummary();
    expect(screen.queryByText(/Thought\s*\(\d+\)/i)).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /system info/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.process-tool-panel')).toBeNull();
    expect(screen.queryByText('Response')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelector('.process-tool-panel')).toBeTruthy();
    expect(screen.getByText('Response')).toBeInTheDocument();
  });

  it('keeps running tool expand/shimmer state across streaming re-render', () => {
    const running = makeToolBlock('tool_run', 'read_file', 'running', {
      context: JSON.stringify({ path: 'a.ts' }),
    });
    const { rerender } = renderTimeline(
      [
        { id: 'th1', type: 'thinking', content: 'Reading…' },
        running,
      ],
      { streaming: true, isLast: true },
    );

    const row = document.querySelector(
      '[data-slot="tool-step-row"][data-status="running"]',
    );
    expect(row).toBeTruthy();
    expect(row).toHaveAttribute('data-expanded', 'true');
    const toggle = row!.querySelector('button');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const updatedRunning: MessageBlock = {
      ...running,
      tool: {
        ...running.tool!,
        context: JSON.stringify({ path: 'a.ts' }),
        preview: 'line 1\nline 2',
      },
    };

    rerender(
      <MemoryRouter initialEntries={['/session/sess_test']}>
        <AssistantBlockTimeline
          displayBlocks={[
            { id: 'th1', type: 'thinking', content: 'Reading the file…' },
            updatedRunning,
          ]}
          message={makeMessage()}
          isLast
          streaming
          showPendingThinking={false}
        />
      </MemoryRouter>,
    );

    const rowAfter = document.querySelector(
      '[data-slot="tool-step-row"][data-status="running"]',
    );
    expect(rowAfter).toHaveAttribute('data-expanded', 'true');
    expect(rowAfter!.querySelector('button')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('back-to-back tools keep independent expand state', () => {
    renderTimeline(
      [
        makeToolBlock('tool_a', 'read_file', 'running', {
          context: JSON.stringify({ path: 'a.ts' }),
        }),
        makeToolBlock('tool_b', 'write_file', 'running', {
          context: JSON.stringify({ path: 'b.ts' }),
        }),
      ],
      { streaming: true },
    );

    const a = screen.getByRole('button', { name: /Reading/i });
    const b = screen.getByRole('button', { name: /Writing/i });
    expect(a).toHaveAttribute('aria-expanded', 'true');
    expect(b).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(a);
    expect(a).toHaveAttribute('aria-expanded', 'false');
    expect(b).toHaveAttribute('aria-expanded', 'true');
  });

  it('thinking steps render without Thought (N) count label', () => {
    renderTimeline([
      { id: 'th1', type: 'thinking', content: 'First thought.' },
      { id: 'th2', type: 'thinking', content: 'Second thought.' },
      {
        id: 'f1',
        type: 'finalOutput',
        content: 'Answer.',
      },
    ]);

    expandActivitySummary();
    expect(screen.queryByText(/Thought\s*\(\d+\)/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Thinking\s*\(\d+\)/i)).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="thought-step"]').length).toBe(1);
  });

  it('expands thoughts by default inside the activity pack', () => {
    renderTimeline([
      { id: 'th1', type: 'thinking', content: 'First thought.' },
      {
        id: 'f1',
        type: 'finalOutput',
        content: 'Answer.',
      },
    ]);

    const pack = document.querySelector('[data-slot="activity-summary"]');
    expect(pack).toHaveAttribute('data-expanded', 'false');
    expandActivitySummary();
    const thought = document.querySelector('[data-slot="thought-step"]');
    expect(thought).toBeTruthy();
    expect(thought).toHaveAttribute('data-expanded', 'true');
    expect(thought).toHaveAttribute('data-done', 'true');
    expect(document.querySelector('.process-thought-prose')).toBeTruthy();
    expect(document.querySelector('.process-thought-clock')).toBeTruthy();
    expect(document.querySelector('.process-thought-stem')).toBeTruthy();
    expect(document.querySelector('.process-thought-check')).toBeTruthy();
    expect(document.querySelector('[data-slot="thought-done"]')).toBeTruthy();
    expect(
      document.querySelector('.process-thought-prose')?.textContent,
    ).toContain('First thought.');
    expect(screen.getByText('Done')).toBeInTheDocument();

    const toggle = thought!.querySelector('button');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle!);
    expect(
      document.querySelector('[data-slot="thought-step"]'),
    ).toHaveAttribute('data-expanded', 'false');
    expect(document.querySelector('.process-thought-prose')).toBeNull();
  });

  it('shows Done only on the last thought after final response', () => {
    renderTimeline([
      { id: 'th1', type: 'thinking', content: 'First thought.' },
      makeToolBlock('tool_a', 'memory_search', 'done', {
        summary: 'ok',
      }),
      { id: 'th2', type: 'thinking', content: 'Second thought.' },
      {
        id: 'f1',
        type: 'finalOutput',
        content: 'Answer.',
      },
    ]);

    expandActivitySummary();
    const thoughts = document.querySelectorAll('[data-slot="thought-step"]');
    expect(thoughts.length).toBe(2);
    expect(thoughts[0]).toHaveAttribute('data-done', 'false');
    expect(thoughts[1]).toHaveAttribute('data-done', 'true');
    expect(screen.getAllByText('Done')).toHaveLength(1);
  });

  it('keyboard Enter on collapsed tool toggles aria-expanded', () => {
    renderTimeline([
      makeToolBlock('tool_k', 'system_info', 'done', {
        summary: '{"ok":1}',
      }),
    ]);

    expandActivitySummary();
    const toggle = screen.getByRole('button', { name: /system info/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'Enter', code: 'Enter' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('updates collapsed label when same tool.id gets new context without resetting expand', () => {
    const block = makeToolBlock('tool_same', 'read_file', 'done', {
      context: JSON.stringify({ path: 'old.ts' }),
      summary: 'old',
    });
    const { rerender } = renderTimeline([block]);

    expandActivitySummary();
    const toggle = screen.getByRole('button', { name: /Read/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <MemoryRouter initialEntries={['/session/sess_test']}>
        <AssistantBlockTimeline
          displayBlocks={[
            {
              ...block,
              tool: {
                ...block.tool!,
                context: JSON.stringify({ path: 'new.ts' }),
                summary: 'new summary',
              },
            },
          ]}
          message={makeMessage()}
          isLast
          streaming={false}
          showPendingThinking={false}
        />
      </MemoryRouter>,
    );

    expandActivitySummary();
    expect(screen.getByRole('button', { name: /Read/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
