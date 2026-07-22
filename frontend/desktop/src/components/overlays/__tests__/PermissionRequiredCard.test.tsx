import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { PermissionRequiredCard } from '../PermissionRequiredCard';
import {
  MutationDiffCards,
  choiceToDecision,
  commandFromMutation,
  descriptionFromMutation,
} from '../MutationDiffCards';
import type { SessionStatus } from '@/hooks/useSessionStatus';

const postMock = vi.fn();

vi.mock('@/api/client', () => ({
  api: {
    post: (...args: unknown[]) => postMock(...args),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    message: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function renderWithQc(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('choiceToDecision', () => {
  it('maps Allow / Always / Deny to confirm-mutation payload fields', () => {
    expect(choiceToDecision('allow')).toEqual({ reject: false, scope: 'once' });
    expect(choiceToDecision('always')).toEqual({ reject: false, scope: 'always' });
    expect(choiceToDecision('deny')).toEqual({ reject: true, scope: 'once' });
  });
});

describe('mutation helpers', () => {
  it('extracts shell command from args', () => {
    expect(
      commandFromMutation({
        toolName: 'run_terminal_cmd',
        args: { command: 'git log --oneline -30' },
      }),
    ).toBe('git log --oneline -30');
  });

  it('extracts command from Run: preview', () => {
    expect(
      commandFromMutation({
        preview: 'Run: cd /c/Dev/august-proxy && git status',
      }),
    ).toBe('cd /c/Dev/august-proxy && git status');
  });

  it('builds a short description from command', () => {
    expect(
      descriptionFromMutation({
        args: { command: 'git log --oneline -30' },
      }),
    ).toContain('git log');
  });
});

describe('PermissionRequiredCard', () => {
  it('confirms immediately when a choice is clicked', async () => {
    const onConfirm = vi.fn();
    render(
      <PermissionRequiredCard description="Shell" onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByTestId('permission-choice-deny'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('deny'));
  });

  it('defaults to Allow and confirms with that choice', async () => {
    const onConfirm = vi.fn();
    render(
      <PermissionRequiredCard
        description="Check git log for recent changes"
        preview={<div>$ git log</div>}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText('Permission required')).toBeInTheDocument();
    expect(screen.getByTestId('permission-awaiting-badge')).toHaveTextContent(
      'Awaiting approval',
    );
    expect(screen.getByTestId('permission-choice-allow')).toHaveAttribute(
      'data-selected',
      'true',
    );

    fireEvent.click(screen.getByTestId('permission-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('allow'));
  });

  it('moves selection with arrow keys and confirms with Enter', async () => {
    const onConfirm = vi.fn();
    render(
      <PermissionRequiredCard
        description="Shell"
        onConfirm={onConfirm}
      />,
    );

    const card = screen.getByTestId('permission-required-card');
    fireEvent.keyDown(card, { key: 'ArrowDown' });
    expect(screen.getByTestId('permission-choice-always')).toHaveAttribute(
      'data-selected',
      'true',
    );
    fireEvent.keyDown(card, { key: 'ArrowDown' });
    expect(screen.getByTestId('permission-choice-deny')).toHaveAttribute(
      'data-selected',
      'true',
    );
    fireEvent.keyDown(card, { key: 'Enter' });
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('deny'));
  });

  it('selects by number keys without confirming', () => {
    const onConfirm = vi.fn();
    render(
      <PermissionRequiredCard description="x" onConfirm={onConfirm} />,
    );
    const card = screen.getByTestId('permission-required-card');
    fireEvent.keyDown(card, { key: '2' });
    expect(screen.getByTestId('permission-choice-always')).toHaveAttribute(
      'data-selected',
      'true',
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('MutationDiffCards', () => {
  beforeEach(() => {
    postMock.mockReset();
    postMock.mockResolvedValue({ executed: true, continued: true, sinceSeq: 12 });
  });

  const shellStatus: SessionStatus = {
    sessionId: 'wb_1',
    status: 'awaiting_approval',
    pendingTool: 'run_terminal_cmd',
    pendingToken: 'tok_shell',
    pendingArgs: { command: 'git log --oneline -30' },
    pendingPreview: null,
    pendingPath: null,
    pendingCreatedAt: null,
    updatedAt: null,
    guardMode: 'full',
    approved: false,
  };

  it('renders shell preview with $ prefix', () => {
    renderWithQc(
      <MutationDiffCards sessionId="wb_1" status={shellStatus} />,
    );
    expect(screen.getByTestId('permission-required-card')).toBeInTheDocument();
    expect(screen.getByText('No output.')).toBeInTheDocument();
    expect(screen.getByText('$', { exact: true })).toBeInTheDocument();
  });

  it('posts once scope when Allow is clicked', async () => {
    renderWithQc(
      <MutationDiffCards sessionId="wb_1" status={shellStatus} />,
    );
    fireEvent.click(screen.getByTestId('permission-choice-allow'));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/workbench/confirm-mutation', {
        sessionId: 'wb_1',
        token: 'tok_shell',
        reject: false,
        scope: 'once',
        continue: true,
      }),
    );
  });

  it('posts always scope when Always is clicked', async () => {
    renderWithQc(
      <MutationDiffCards sessionId="wb_1" status={shellStatus} />,
    );
    fireEvent.click(screen.getByTestId('permission-choice-always'));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/workbench/confirm-mutation', {
        sessionId: 'wb_1',
        token: 'tok_shell',
        reject: false,
        scope: 'always',
        continue: true,
      }),
    );
  });

  it('posts reject when Deny is clicked', async () => {
    renderWithQc(
      <MutationDiffCards sessionId="wb_1" status={shellStatus} />,
    );
    fireEvent.click(screen.getByTestId('permission-choice-deny'));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/workbench/confirm-mutation', {
        sessionId: 'wb_1',
        token: 'tok_shell',
        reject: true,
        scope: 'once',
        continue: true,
      }),
    );
  });

  it('renders DiffView-style preview for file edits', () => {
    const fileStatus: SessionStatus = {
      ...shellStatus,
      pendingToken: 'tok_file',
      pendingTool: 'search_replace',
      pendingArgs: {
        path: 'src/a.ts',
        old_string: 'foo',
        new_string: 'bar',
      },
      pendingPath: 'src/a.ts',
    };
    renderWithQc(
      <MutationDiffCards sessionId="wb_1" status={fileStatus} />,
    );
    expect(screen.getByTestId('permission-required-card')).toBeInTheDocument();
    expect(screen.getAllByText(/foo|bar/).length).toBeGreaterThanOrEqual(2);
  });
});
