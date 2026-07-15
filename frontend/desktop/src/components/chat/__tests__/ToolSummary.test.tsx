import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  ToolSummary,
  buildToolSummaryEntry,
  plural,
  SETTLE_COLLAPSE_MS,
  type ToolSummaryEntry,
} from '../ToolSummary';
import type { ToolEntry } from '../ToolCallItem';
import { classifyTool } from '@/lib/tool-classify';

function makeTool(partial: Partial<ToolEntry> & Pick<ToolEntry, 'id' | 'name'>): ToolEntry {
  return {
    status: 'done',
    ...partial,
  };
}

function makeEntry(tool: ToolEntry, overrides: Partial<ToolSummaryEntry> = {}): ToolSummaryEntry {
  return {
    ...buildToolSummaryEntry(tool),
    ...overrides,
  };
}

describe('plural', () => {
  it('singular and plural forms', () => {
    expect(plural(1, 'thought', 'thoughts')).toBe('1 thought');
    expect(plural(3, 'thought', 'thoughts')).toBe('3 thoughts');
  });
});

describe('buildToolSummaryEntry + classifyTool wiring', () => {
  it('builds view/edit/run/tool buckets correctly for common names', () => {
    expect(classifyTool('august__read_file')).toBe('view');
    expect(classifyTool('write_file')).toBe('edit');
    expect(classifyTool('@run_command')).toBe('run');
    expect(classifyTool('august__spawn_subagent')).toBe('tool');
  });

  it('extracts path detail and past-tense label when done', () => {
    const tool = makeTool({
      id: 't1',
      name: 'read_file',
      status: 'done',
      context: JSON.stringify({ path: 'src/app.ts' }),
    });
    const entry = buildToolSummaryEntry(tool);
    expect(entry.filename).toBe('src/app.ts');
    expect(entry.label.toLowerCase()).toContain('read');
    expect(entry.detail).toBeTruthy();
  });

  it('marks stalled tools when startedAt is old', () => {
    const now = 1_000_000;
    const tool = makeTool({
      id: 't2',
      name: 'run_command',
      status: 'running',
      startedAt: now - 200_000,
      context: JSON.stringify({ command: 'npm test' }),
    });
    const entry = buildToolSummaryEntry(tool, { now });
    expect(entry.stalled).toBe(true);
    expect(entry.isCommand).toBe(true);
  });

  it('flags awaiting approval', () => {
    const tool = makeTool({
      id: 't3',
      name: 'write_file',
      status: 'running',
      pendingApproval: { message: 'Approve write?' },
      context: JSON.stringify({ path: 'a.ts' }),
    });
    const entry = buildToolSummaryEntry(tool);
    expect(entry.awaitingApproval).toBe(true);
  });
});

describe('ToolSummary UI', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('omits zero buckets and pluralizes counts in the header', () => {
    const entries = [
      makeEntry(makeTool({ id: 'a', name: 'read_file', context: '{"path":"a.ts"}' })),
    ];
    render(
      <ToolSummary
        thoughtCount={3}
        viewedCount={7}
        editedCount={0}
        ranCount={1}
        usedCount={0}
        entries={entries}
        isLive={false}
        renderToolBody={() => <div>body</div>}
      />,
    );
    const header = screen.getByRole('button', { expanded: false });
    expect(header.textContent).toMatch(/3 thoughts/);
    expect(header.textContent).toMatch(/7 viewed/);
    expect(header.textContent).toMatch(/1 ran/);
    expect(header.textContent).not.toMatch(/edited/);
    expect(header.textContent).not.toMatch(/used/);
  });

  it('starts expanded when isLive and collapses after settle delay', async () => {
    const entries = [
      makeEntry(makeTool({ id: 'a', name: 'read_file', status: 'running', context: '{"path":"a.ts"}' }), {
        status: 'running',
      }),
    ];
    const { rerender } = render(
      <ToolSummary
        thoughtCount={0}
        viewedCount={1}
        editedCount={0}
        ranCount={0}
        usedCount={0}
        entries={entries}
        isLive
        renderToolBody={() => <div data-testid="tool-body">body</div>}
      />,
    );

    const root = document.querySelector('[data-slot="tool-summary"]');
    expect(root?.getAttribute('data-expanded')).toBe('true');
    expect(root?.getAttribute('data-live')).toBe('true');

    // Settle: no longer live, entry done, no attention
    const settled = [
      makeEntry(makeTool({ id: 'a', name: 'read_file', status: 'done', context: '{"path":"a.ts"}' })),
    ];
    rerender(
      <ToolSummary
        thoughtCount={0}
        viewedCount={1}
        editedCount={0}
        ranCount={0}
        usedCount={0}
        entries={settled}
        isLive={false}
        renderToolBody={() => <div data-testid="tool-body">body</div>}
      />,
    );

    // Still open during settle delay
    expect(document.querySelector('[data-slot="tool-summary"]')?.getAttribute('data-expanded')).toBe('true');

    await act(async () => {
      vi.advanceTimersByTime(SETTLE_COLLAPSE_MS);
    });

    expect(document.querySelector('[data-slot="tool-summary"]')?.getAttribute('data-expanded')).toBe('false');
  });

  it('stays open when settled with errors and shows attention', () => {
    const entries = [
      makeEntry(makeTool({ id: 'a', name: 'read_file', status: 'error', error: 'boom' }), {
        status: 'error',
      }),
    ];
    render(
      <ToolSummary
        thoughtCount={0}
        viewedCount={1}
        editedCount={0}
        ranCount={0}
        usedCount={0}
        entries={entries}
        isLive={false}
        renderToolBody={() => <div>body</div>}
      />,
    );
    const root = document.querySelector('[data-slot="tool-summary"]');
    expect(root?.getAttribute('data-expanded')).toBe('true');
    expect(root?.getAttribute('data-attention')).toBe('error');
  });

  it('expands a row to reveal the tool body on click', () => {
    const tool = makeTool({ id: 'a', name: 'read_file', status: 'done', context: '{"path":"a.ts"}' });
    const entries = [makeEntry(tool)];
    render(
      <ToolSummary
        thoughtCount={0}
        viewedCount={1}
        editedCount={0}
        ranCount={0}
        usedCount={0}
        entries={entries}
        isLive
        renderToolBody={(t) => <div data-testid="tool-body">body:{t.id}</div>}
      />,
    );

    expect(screen.queryByTestId('tool-body')).toBeNull();

    // First matching row button (after header)
    const rowButtons = screen.getAllByRole('button');
    // header + row
    const row = rowButtons.find((b) => b.classList.contains('tool-summary-row'));
    expect(row).toBeTruthy();
    fireEvent.click(row!);

    expect(screen.getByTestId('tool-body')).toHaveTextContent('body:a');
  });

  it('applies shimmer class to short running row labels', () => {
    const tool = makeTool({ id: 'a', name: 'read_file', status: 'running', context: '{"path":"a.ts"}' });
    const entries = [makeEntry(tool, { status: 'running', label: 'Reading' })];
    render(
      <ToolSummary
        thoughtCount={0}
        viewedCount={1}
        editedCount={0}
        ranCount={0}
        usedCount={0}
        entries={entries}
        isLive
        renderToolBody={() => null}
      />,
    );
    const label = document.querySelector('.tool-summary-row-label');
    expect(label?.classList.contains('shimmer')).toBe(true);
  });

  it('does not shimmer long running labels', () => {
    const longLabel = 'Running: ' + 'x'.repeat(50);
    const tool = makeTool({
      id: 'a',
      name: 'run_command',
      status: 'running',
      context: JSON.stringify({ command: 'x'.repeat(60) }),
    });
    const entries = [makeEntry(tool, { status: 'running', label: longLabel, isCommand: true })];
    render(
      <ToolSummary
        thoughtCount={0}
        viewedCount={0}
        editedCount={0}
        ranCount={1}
        usedCount={0}
        entries={entries}
        isLive
        renderToolBody={() => null}
      />,
    );
    const label = document.querySelector('.tool-summary-row-label');
    expect(label?.classList.contains('shimmer')).toBe(false);
  });

  it('user can toggle header open/closed', () => {
    const entries = [
      makeEntry(makeTool({ id: 'a', name: 'read_file', status: 'done', context: '{"path":"a.ts"}' })),
    ];
    render(
      <ToolSummary
        thoughtCount={1}
        viewedCount={1}
        editedCount={0}
        ranCount={0}
        usedCount={0}
        entries={entries}
        isLive={false}
        renderToolBody={() => <div>body</div>}
      />,
    );

    // After mount with isLive false, delay may still have delayedAutoOpen from initial
    // Initial wantAutoOpen is false, so delayedAutoOpen starts false → collapsed
    const header = screen.getByRole('button', { name: /thought|viewed/i });
    expect(document.querySelector('[data-slot="tool-summary"]')?.getAttribute('data-expanded')).toBe('false');

    fireEvent.click(header);
    expect(document.querySelector('[data-slot="tool-summary"]')?.getAttribute('data-expanded')).toBe('true');

    fireEvent.click(header);
    expect(document.querySelector('[data-slot="tool-summary"]')?.getAttribute('data-expanded')).toBe('false');
  });
});
