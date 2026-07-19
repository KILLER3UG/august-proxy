import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AssistantBlockTimeline } from '../AssistantBlockTimeline';
import type { ChatMessage, MessageBlock } from '@/types/chat';

vi.mock('@/store/liveActivity', () => ({
  clearLiveActivity: vi.fn(),
  publishLiveActivity: vi.fn(),
}));

vi.mock('@/components/shell/RightDrawerState', () => ({
  addRightDrawerSection: vi.fn(),
  clearActivityAutoOpenSuppression: vi.fn(),
  closeRightDrawerSection: vi.fn(),
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

describe('AssistantBlockTimeline process UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
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
    const toggle = screen.getByRole('button', { name: /Reading/i });
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
    expect(screen.getByRole('button', { name: /Reading/i })).toHaveAttribute(
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

    expect(screen.queryByText(/Thought\s*\(\d+\)/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Thinking\s*\(\d+\)/i)).not.toBeInTheDocument();
    expect(screen.getByText(/First thought/)).toBeInTheDocument();
    expect(screen.getByText(/Second thought/)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="thought-step"]').length).toBe(1);
  });

  it('keyboard Enter on collapsed tool toggles aria-expanded', () => {
    renderTimeline([
      makeToolBlock('tool_k', 'system_info', 'done', {
        summary: '{"ok":1}',
      }),
    ]);

    const toggle = screen.getByRole('button', { name: /system info/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    // Real <button> activates on click (Enter/Space in browsers); assert a11y attrs + toggle.
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

    expect(screen.getByRole('button', { name: /Read/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
