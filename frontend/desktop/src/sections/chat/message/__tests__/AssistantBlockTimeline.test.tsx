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
    const thought = document.querySelector('[data-slot="thought-step"]');
    expect(thought).toBeTruthy();
    // Settled reasoning renders as prose on the rail (clamped only when long);
    // the threaded rail line replaces the old per-thought stem.
    expect(document.querySelector('.process-thought-prose')).toBeTruthy();
    expect(thought?.querySelector('.rail-line')).toBeTruthy();
    expect(
      document.querySelector('.process-thought-prose')?.textContent,
    ).toContain('Considering the clock.');
    expect(screen.getByRole('button', { name: /system info/i })).toBeTruthy();
  });

  it('keeps thinking pack collapsed to one line while streaming before final output', () => {
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
    expect(pack).toHaveAttribute('data-expanded', 'false');
    expect(pack).toHaveAttribute('data-live', 'true');
    expect(document.querySelector('[data-slot="thought-step"]')).toBeNull();
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
      // Non-view tool so summary remains expandable (view tools are header-only).
      makeToolBlock('tool_a', 'diagnose_proxy', 'done', {
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

    const toggle = screen.getByRole('button', { name: /diagnos/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(
      document.querySelector('[data-slot="tool-step-row"] [data-state="open"]'),
    ).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // The Task block's CollapsibleContent is now open.
    const row = document.querySelector('[data-slot="tool-step-row"]');
    expect(row).toHaveAttribute('data-expanded', 'true');
    expect(row!.querySelector('[data-state="open"]')).toBeTruthy();
  });

  it('keeps running edit-tool expand/shimmer state across streaming re-render', () => {
    const running = makeToolBlock('tool_run', 'write_file', 'running', {
      context: JSON.stringify({ path: 'a.ts', content: 'x' }),
    });
    const { rerender } = renderTimeline(
      [
        { id: 'th1', type: 'thinking', content: 'Writing…' },
        running,
      ],
      { streaming: true, isLast: true },
    );

    expandActivitySummary();
    const row = document.querySelector(
      '[data-slot="edit-rail-row"][data-status="running"]',
    );
    expect(row).toBeTruthy();
    expect(row).toHaveAttribute('data-expanded', 'true');
    const toggle = row!.querySelector('button');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const updatedRunning: MessageBlock = {
      ...running,
      tool: {
        ...running.tool!,
        context: JSON.stringify({ path: 'a.ts', content: 'xy' }),
        preview: 'line 1\nline 2',
      },
    };

    rerender(
      <MemoryRouter initialEntries={['/session/sess_test']}>
        <AssistantBlockTimeline
          displayBlocks={[
            { id: 'th1', type: 'thinking', content: 'Writing the file…' },
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
      '[data-slot="edit-rail-row"][data-status="running"]',
    );
    expect(rowAfter).toHaveAttribute('data-expanded', 'true');
    expect(rowAfter!.querySelector('button')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('keeps view/read tools collapsed while running (no content preview)', () => {
    renderTimeline(
      [
        makeToolBlock('tool_read', 'read_file', 'running', {
          context: JSON.stringify({ path: 'a.ts' }),
        }),
      ],
      { streaming: true, isLast: true },
    );

    expandActivitySummary();
    const row = document.querySelector(
      '[data-slot="tool-step-row"][data-status="running"]',
    );
    expect(row).toHaveAttribute('data-expanded', 'false');
    const toggle = row!.querySelector('button');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('back-to-back tools keep independent expand state', () => {
    renderTimeline(
      [
        makeToolBlock('tool_a', 'read_file', 'running', {
          context: JSON.stringify({ path: 'a.ts' }),
        }),
        makeToolBlock('tool_b', 'write_file', 'running', {
          context: JSON.stringify({ path: 'b.ts', content: 'y' }),
        }),
      ],
      { streaming: true },
    );

    expandActivitySummary();
    const a = screen.getByRole('button', { name: /Reading/i });
    const b = screen.getByRole('button', { name: /Writing/i });
    // View tools stay collapsed; edit tools auto-expand while running.
    expect(a).toHaveAttribute('aria-expanded', 'false');
    expect(b).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(b);
    expect(a).toHaveAttribute('aria-expanded', 'false');
    expect(b).toHaveAttribute('aria-expanded', 'false');
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

  it('renders settled reasoning as prose with a single rail Done marker', () => {
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
    // Short settled reasoning shows in full — prose is always in the DOM now
    // (long thoughts clamp with a Show more control instead of collapsing).
    expect(document.querySelector('.process-thought-prose')).toBeTruthy();
    expect(document.querySelector('.process-thought-prose')?.textContent).toContain(
      'First thought.',
    );
    expect(document.querySelector('.process-thought-clock')).toBeTruthy();
    // The per-thought Done / stem / check chrome is gone — completion moved to
    // the rail level.
    expect(document.querySelector('[data-slot="thought-done"]')).toBeNull();
    expect(document.querySelector('.process-thought-check')).toBeNull();
    const done = document.querySelector('[data-slot="rail-done-row"]');
    expect(done).toBeTruthy();
    expect(done).toHaveAttribute('data-status', 'done');
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('shows a single rail Done marker regardless of thought count', () => {
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
    // Completion is one rail marker at the foot of the thread, not stamped on
    // the last thought.
    expect(document.querySelectorAll('[data-slot="rail-done-row"]').length).toBe(1);
    expect(screen.getAllByText('Done')).toHaveLength(1);
  });

  it('keyboard Enter on collapsed tool toggles aria-expanded', () => {
    renderTimeline([
      makeToolBlock('tool_k', 'diagnose_proxy', 'done', {
        summary: '{"ok":1}',
      }),
    ]);

    expandActivitySummary();
    const toggle = screen.getByRole('button', { name: /diagnos/i });
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
    const block = makeToolBlock('tool_same', 'write_file', 'done', {
      context: JSON.stringify({ path: 'old.ts', content: 'a' }),
      summary: 'Wrote old.ts',
    });
    const { rerender } = renderTimeline([block]);

    expandActivitySummary();
    const toggle = screen.getByRole('button', { name: /Wrote|Writing|Write/i });
    // Plan §4.1: edit rows with a diff are expanded by default.
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    rerender(
      <MemoryRouter initialEntries={['/session/sess_test']}>
        <AssistantBlockTimeline
          displayBlocks={[
            {
              ...block,
              tool: {
                ...block.tool!,
                context: JSON.stringify({ path: 'new.ts', content: 'b' }),
                summary: 'Wrote new.ts',
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
    // The user's collapse must survive the context update (no re-expand).
    expect(screen.getByRole('button', { name: /Wrote|Writing|Write/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('read tools stay header-only with no expandable content preview', () => {
    renderTimeline([
      makeToolBlock('tool_read_done', 'read_file', 'done', {
        context: JSON.stringify({ path: 'foo.py' }),
        summary: 'def main():\n  pass\n' + 'x'.repeat(200),
      }),
    ]);

    expandActivitySummary();
    const toggle = screen.getByRole('button', { name: /Read|Reading/i });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.process-tool-panel')).toBeNull();
    // Truncated file body must not appear in the timeline.
    expect(screen.queryByText(/def main/)).not.toBeInTheDocument();
  });
});

describe('minimal-output transcript (plan §4.1/§4.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('memory write renders as a rail row with the saved entry text', () => {
    renderTimeline([
      makeToolBlock('tool_mem', 'remember', 'done', {
        context: JSON.stringify({
          fact: 'User prefers dark mode',
          title: 'Dark mode preference',
        }),
        summary: JSON.stringify({
          ok: true,
          key: 'pref:dark-mode',
          category: 'preference',
        }),
      }),
    ]);

    expandActivitySummary();
    const row = document.querySelector('[data-slot="memory-rail-row"]');
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain('Saved memory');
    expect(row!.textContent).toContain('Dark mode preference');
    // Expanded by default — the saved entry text is the point of the row.
    expect(row!.textContent).toContain('User prefers dark mode');
    expect(row!.textContent).toContain('pref:dark-mode');
  });

  it('failed command shows one red line inline; full output behind the click', () => {
    const output = [
      'collected 2 items',
      '',
      'test_a.py::test_ok PASSED',
      'test_a.py::test_bad FAILED',
      '',
      'AssertionError: expected 200, got 500',
      '= 1 failed, 1 passed in 0.42s =',
      'Exit code: 1',
    ].join('\n');
    renderTimeline([
      {
        id: 'block_cmd_fail',
        type: 'command',
        tool: {
          id: 'cmd_fail',
          name: 'run_command',
          status: 'error',
          context: JSON.stringify({ command: 'python -m pytest -x' }),
          summary: output,
          error: output,
        },
      },
    ]);

    expandActivitySummary();
    // One red line on the row itself — the structured pytest digest.
    const inlineErr = screen.getByTestId('tool-error-line');
    expect(inlineErr.textContent).toContain('1 failed, 1 passed');
    // Full output stays behind the click until the row is expanded.
    expect(document.querySelector('[data-testid="command-output-pane"]')).toBeNull();
    const toggle = screen.getByRole('button', { name: /Ran/i });
    fireEvent.click(toggle);
    const pane = document.querySelector('[data-testid="command-output-pane"]');
    expect(pane).toBeTruthy();
    expect(pane!.querySelector('[data-testid="command-full-output"]')).toBeNull();
    fireEvent.click(pane!.querySelector('[data-testid="command-output-toggle"]')!);
    expect(
      pane!.querySelector('[data-testid="command-full-output"]')!.textContent,
    ).toContain('AssertionError');
  });

  it('successful command rows are header-only (no chevron, no pane)', () => {
    renderTimeline([
      {
        id: 'block_cmd_ok',
        type: 'command',
        tool: {
          id: 'cmd_ok',
          name: 'run_command',
          status: 'done',
          context: JSON.stringify({ command: 'ls -la' }),
          summary: 'total 8\ndrwxr-xr-x 2 user user 4096 .',
        },
      },
    ]);

    expandActivitySummary();
    const toggle = screen.getByRole('button', { name: /Ran: ls -la/i });
    expect(toggle).toBeDisabled();
    expect(document.querySelector('[data-testid="command-output-pane"]')).toBeNull();
    // Raw output never streams into the transcript on success.
    expect(screen.queryByText(/drwxr-xr-x/)).not.toBeInTheDocument();
  });

  it('consecutive reads of the same file collapse into one ×N row', () => {
    renderTimeline([
      makeToolBlock('r1', 'read_file', 'done', {
        context: JSON.stringify({ path: 'consolidation.py' }),
        summary: 'a',
        duration: 200,
      }),
      makeToolBlock('r2', 'read_file', 'done', {
        context: JSON.stringify({ path: 'consolidation.py' }),
        summary: 'b',
        duration: 300,
      }),
      makeToolBlock('r3', 'read_file', 'done', {
        context: JSON.stringify({ path: 'consolidation.py' }),
        summary: 'c',
        duration: 900,
      }),
    ]);

    expandActivitySummary();
    expect(screen.getByText(/Read consolidation\.py ×3/)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="tool-step-row"]').length).toBe(1);
    // Summed duration crosses 1s, so it shows.
    expect(screen.getByTestId('tool-read-duration').textContent).toBe('1.4s');
  });

  it('groups tool rows under update_state phase markers (plan tree)', () => {
    renderTimeline([
      { id: 'ph1', type: 'phase', content: 'Investigate', step: 1 },
      makeToolBlock('t1', 'read_file', 'done', {
        context: JSON.stringify({ path: 'a.py' }),
      }),
      { id: 'ph2', type: 'phase', content: 'Fix', step: 2 },
      makeToolBlock('t2', 'write_file', 'done', {
        context: JSON.stringify({ path: 'a.py', content: 'new' }),
        summary: 'Wrote a.py',
      }),
      { id: 'f1', type: 'finalOutput', content: 'Done.' },
    ]);

    expandActivitySummary();
    const heads = screen.getAllByTestId('plan-phase-head');
    expect(heads).toHaveLength(2);
    expect(heads[0].textContent).toContain('Investigate');
    expect(heads[0].textContent).toContain('step 1');
    expect(heads[1].textContent).toContain('Fix');
    // Settled turn — finished subtrees auto-collapse.
    heads.forEach((h) => expect(h).toHaveAttribute('aria-expanded', 'false'));
    // Expanding a group reveals its rows.
    fireEvent.click(heads[0]);
    expect(heads[0]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Read a\.py/)).toBeInTheDocument();
  });

  it('highlights and expands the active phase group while streaming', () => {
    renderTimeline(
      [
        { id: 'ph1', type: 'phase', content: 'Investigate', step: 1 },
        makeToolBlock('t1', 'read_file', 'done', {
          context: JSON.stringify({ path: 'a.py' }),
        }),
        { id: 'ph2', type: 'phase', content: 'Fix', step: 2 },
        makeToolBlock('t2', 'read_file', 'running', {
          context: JSON.stringify({ path: 'b.py' }),
        }),
      ],
      { streaming: true, isLast: true },
    );

    expandActivitySummary();
    const groups = document.querySelectorAll('[data-slot="plan-phase-group"]');
    expect(groups.length).toBe(2);
    expect(groups[0]).toHaveAttribute('data-active', 'false');
    expect(groups[1]).toHaveAttribute('data-active', 'true');
    expect(
      groups[0].querySelector('[data-testid="plan-phase-head"]'),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(
      groups[1].querySelector('[data-testid="plan-phase-head"]'),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders flat when the model emitted no phases (graceful fallback)', () => {
    renderTimeline([
      makeToolBlock('t1', 'read_file', 'done', {
        context: JSON.stringify({ path: 'a.py' }),
      }),
    ]);

    expandActivitySummary();
    expect(document.querySelector('[data-slot="plan-phase-group"]')).toBeNull();
    expect(document.querySelector('[data-slot="tool-step-row"]')).toBeTruthy();
  });

  it('update_state calls are represented by the phase marker, not a duplicate row', () => {
    renderTimeline([
      makeToolBlock('us1', 'update_state', 'done', {
        context: JSON.stringify({ phase: 'Fix', step: 2 }),
      }),
      { id: 'ph1', type: 'phase', content: 'Fix', step: 2 },
      makeToolBlock('t1', 'read_file', 'done', {
        context: JSON.stringify({ path: 'a.py' }),
      }),
    ]);

    expandActivitySummary();
    // The transition renders once — as the phase head, never as an edit row.
    expect(document.querySelectorAll('[data-slot="edit-rail-row"]').length).toBe(0);
    expect(screen.getAllByTestId('plan-phase-head').length).toBe(1);
  });

  it('folds consecutive reads of the same file into one ×N row (plan 15.1)', () => {
    renderTimeline([
      makeToolBlock('r1', 'read_file', 'done', {
        context: JSON.stringify({ path: 'src/consolidation.py' }),
      }),
      makeToolBlock('r2', 'read_file', 'done', {
        context: JSON.stringify({ path: 'src/consolidation.py' }),
      }),
      makeToolBlock('r3', 'read_file', 'done', {
        context: JSON.stringify({ path: 'src/consolidation.py' }),
      }),
      makeToolBlock('r4', 'read_file', 'done', {
        context: JSON.stringify({ path: 'src/consolidation.py' }),
      }),
    ]);

    expandActivitySummary();
    const rows = document.querySelectorAll('[data-slot="tool-step-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('×4');
    expect(rows[0].textContent).toContain('consolidation.py');
  });

  it('keeps errored reads individual next to the collapsed run (plan 15.1)', () => {
    renderTimeline([
      makeToolBlock('r1', 'read_file', 'done', {
        context: JSON.stringify({ path: 'a.py' }),
      }),
      makeToolBlock('r2', 'read_file', 'done', {
        context: JSON.stringify({ path: 'a.py' }),
      }),
      makeToolBlock('r3', 'read_file', 'error', {
        context: JSON.stringify({ path: 'a.py' }),
        error: 'ENOENT: no such file',
      }),
    ]);

    expandActivitySummary();
    const rows = document.querySelectorAll('[data-slot="tool-step-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('×2');
    expect(rows[1]).toHaveAttribute('data-status', 'error');
  });
});
