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
import {
  approvalChoices,
  canGrantAlways,
  choiceToDecision as scopeChoiceToDecision,
  scopeToDecision,
} from '@/lib/approval-scope';
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

/** A grant specific enough to be made permanent. */
const SAFE_SUBJECT = { grantKey: 'run_command:cmd:9f2c1a', categories: ['read'] };

describe('scope mapping', () => {
  it('maps each rendered choice to confirm-mutation payload fields', () => {
    expect(scopeChoiceToDecision('once')).toEqual({ reject: false, scope: 'once' });
    expect(scopeChoiceToDecision('session')).toEqual({ reject: false, scope: 'session' });
    expect(scopeChoiceToDecision('always')).toEqual({ reject: false, scope: 'always' });
    expect(scopeChoiceToDecision('deny')).toEqual({ reject: true, scope: 'once' });
    expect(scopeChoiceToDecision('instructions')).toEqual({ reject: true, scope: 'once' });
  });

  it('the banner re-exports the one mapping the card and toast share', () => {
    expect(choiceToDecision).toBe(scopeChoiceToDecision);
  });

  it('scopeToDecision never produces a rejecting decision', () => {
    expect(scopeToDecision('once').reject).toBe(false);
    expect(scopeToDecision('session').reject).toBe(false);
    expect(scopeToDecision('always').reject).toBe(false);
  });
});

describe('canGrantAlways', () => {
  it('offers always for a command-specific, non-destructive grant', () => {
    expect(canGrantAlways({ grantKey: 'run_command:cmd:9f2c1a' })).toBe(true);
    expect(canGrantAlways({ grantKey: 'write_file:/app/x.py' })).toBe(true);
  });

  it('withholds always for destructive and network commands', () => {
    expect(canGrantAlways({ grantKey: 'run_command:cmd:a', categories: ['destructive'] })).toBe(false);
    expect(canGrantAlways({ grantKey: 'run_command:cmd:a', categories: ['network'] })).toBe(false);
    expect(canGrantAlways({ grantKey: 'run_command:cmd:a', categories: ['destructive', 'read'] })).toBe(false);
  });

  it('withholds always for broad, escape, unknown, or absent keys', () => {
    expect(canGrantAlways({ grantKey: 'run_command:*' })).toBe(false);
    expect(canGrantAlways({ grantKey: 'delete_file:*' })).toBe(false);
    expect(canGrantAlways({ grantKey: 'run_command:sandbox:unsandboxed:deadbeef' })).toBe(false);
    expect(canGrantAlways({ grantKey: 'run_command:sandbox:unsandboxed:*' })).toBe(false);
    // Fails closed — an unknown key is not specific enough to persist.
    expect(canGrantAlways({})).toBe(false);
    expect(canGrantAlways({ grantKey: '' })).toBe(false);
    expect(canGrantAlways(null)).toBe(false);
    expect(canGrantAlways(undefined)).toBe(false);
  });
});

describe('approvalChoices', () => {
  it('puts always between session and deny when the grant is safe', () => {
    expect(approvalChoices(SAFE_SUBJECT)).toEqual([
      'once',
      'session',
      'always',
      'deny',
      'instructions',
    ]);
  });

  it('drops always for a destructive command but keeps deny reachable', () => {
    const choices = approvalChoices({ grantKey: 'run_command:cmd:a', categories: ['destructive'] });
    expect(choices).toEqual(['once', 'session', 'deny', 'instructions']);
    expect(choices).not.toContain('always');
  });
});

describe('choiceToDecision', () => {
  it('maps Once / This session / Always / Deny / Instructions to confirm-mutation payload fields', () => {
    expect(choiceToDecision('once')).toEqual({ reject: false, scope: 'once' });
    expect(choiceToDecision('session')).toEqual({ reject: false, scope: 'session' });
    expect(choiceToDecision('always')).toEqual({ reject: false, scope: 'always' });
    expect(choiceToDecision('deny')).toEqual({ reject: true, scope: 'once' });
    expect(choiceToDecision('instructions')).toEqual({ reject: true, scope: 'once' });
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
  it('clicking a choice selects it; Confirm button confirms', async () => {
    const onConfirm = vi.fn();
    render(
      <PermissionRequiredCard description="Shell" subject={SAFE_SUBJECT} onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByTestId('permission-choice-deny'));
    expect(screen.getByTestId('permission-choice-deny')).toHaveAttribute(
      'data-selected',
      'true',
    );
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('permission-confirm'));
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith('deny', undefined),
    );
  });

  it('offers Once / This session / Always for a safe grant and defaults to Once', async () => {
    const onConfirm = vi.fn();
    render(
      <PermissionRequiredCard
        description="Check git log for recent changes"
        preview={<div>$ git log</div>}
        subject={SAFE_SUBJECT}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText('Permission required')).toBeInTheDocument();
    expect(screen.getByTestId('permission-awaiting-badge')).toHaveTextContent(
      'Awaiting approval',
    );
    expect(screen.getByTestId('permission-choice-once')).toHaveAttribute(
      'data-selected',
      'true',
    );
    // Scope is stated on the row, not just implied by position.
    expect(screen.getByTestId('permission-choice-session')).toHaveTextContent(
      'This session',
    );
    expect(screen.getByTestId('permission-choice-always')).toBeInTheDocument();
    expect(screen.queryByTestId('permission-always-withheld')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('permission-confirm'));
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith('once', undefined),
    );
  });

  it('withholds Always for a destructive command and says why', async () => {
    const onConfirm = vi.fn();
    render(
      <PermissionRequiredCard
        description="rm -rf build"
        subject={{ grantKey: 'run_command:cmd:ab12', categories: ['destructive'] }}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.queryByTestId('permission-choice-always')).not.toBeInTheDocument();
    expect(screen.getByTestId('permission-always-withheld')).toHaveTextContent(
      'Destructive or network commands',
    );
    // Deny stays reachable — withholding a scope must not trap the user.
    fireEvent.click(screen.getByTestId('permission-choice-deny'));
    fireEvent.click(screen.getByTestId('permission-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('deny', undefined));
  });

  it('withholds Always for a network command', () => {
    render(
      <PermissionRequiredCard
        description="git push --force"
        subject={{ grantKey: 'run_command:cmd:cd34', categories: ['network'] }}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('permission-choice-always')).not.toBeInTheDocument();
    expect(screen.getByTestId('permission-choice-session')).toBeInTheDocument();
  });

  it('withholds Always when the grant key is broad', () => {
    render(
      <PermissionRequiredCard
        description="Run anything"
        subject={{ grantKey: 'run_command:*' }}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('permission-choice-always')).not.toBeInTheDocument();
    expect(screen.getByTestId('permission-always-withheld')).toBeInTheDocument();
  });

  it('moves selection with arrow keys and confirms with Enter', async () => {
    const onConfirm = vi.fn();
    render(
      <PermissionRequiredCard
        description="Shell"
        subject={SAFE_SUBJECT}
        onConfirm={onConfirm}
      />,
    );

    const card = screen.getByTestId('permission-required-card');
    fireEvent.keyDown(card, { key: 'ArrowDown' });
    expect(screen.getByTestId('permission-choice-session')).toHaveAttribute(
      'data-selected',
      'true',
    );
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
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith('deny', undefined),
    );
  });

  it('number keys follow the rendered order, skipping a withheld Always', () => {
    const onConfirm = vi.fn();
    render(
      <PermissionRequiredCard
        description="x"
        subject={{ grantKey: 'run_command:cmd:a', categories: ['network'] }}
        onConfirm={onConfirm}
      />,
    );
    const card = screen.getByTestId('permission-required-card');
    // once · session · deny · instructions — '3' is Deny, not Always.
    fireEvent.keyDown(card, { key: '3' });
    expect(screen.getByTestId('permission-choice-deny')).toHaveAttribute(
      'data-selected',
      'true',
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('selects by number keys without confirming', () => {
    const onConfirm = vi.fn();
    render(
      <PermissionRequiredCard description="x" subject={SAFE_SUBJECT} onConfirm={onConfirm} />,
    );
    const card = screen.getByTestId('permission-required-card');
    fireEvent.keyDown(card, { key: '3' });
    expect(screen.getByTestId('permission-choice-always')).toHaveAttribute(
      'data-selected',
      'true',
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('option 5 reveals an instructions input; Enter submits the text', async () => {
    const onConfirm = vi.fn();
    render(
      <PermissionRequiredCard description="x" subject={SAFE_SUBJECT} onConfirm={onConfirm} />,
    );
    const card = screen.getByTestId('permission-required-card');
    fireEvent.keyDown(card, { key: '5' });
    const input = screen.getByTestId('permission-instructions-input');
    expect(input).toBeInTheDocument();
    // Confirm stays disabled until instructions are non-empty.
    expect(screen.getByTestId('permission-confirm')).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Skip this and edit README.md' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith(
        'instructions',
        'Skip this and edit README.md',
      ),
    );
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
    pendingGrantKey: 'run_command:cmd:9f2c1a',
    pendingCategories: ['read'],
  };

  it('renders shell preview with $ prefix', () => {
    renderWithQc(
      <MutationDiffCards sessionId="wb_1" status={shellStatus} />,
    );
    expect(screen.getByTestId('permission-required-card')).toBeInTheDocument();
    expect(screen.getByText('No output.')).toBeInTheDocument();
    expect(screen.getByText('$', { exact: true })).toBeInTheDocument();
  });

  it('posts once scope when Once is confirmed', async () => {
    renderWithQc(
      <MutationDiffCards sessionId="wb_1" status={shellStatus} />,
    );
    fireEvent.click(screen.getByTestId('permission-choice-once'));
    fireEvent.click(screen.getByTestId('permission-confirm'));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/workbench/confirm-mutation', {
        sessionId: 'wb_1',
        token: 'tok_shell',
        reject: false,
        scope: 'once',
        continue: true,
        instructions: undefined,
      }),
    );
  });

  it('posts session scope when This session is confirmed', async () => {
    renderWithQc(
      <MutationDiffCards sessionId="wb_1" status={shellStatus} />,
    );
    fireEvent.click(screen.getByTestId('permission-choice-session'));
    fireEvent.click(screen.getByTestId('permission-confirm'));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/workbench/confirm-mutation', {
        sessionId: 'wb_1',
        token: 'tok_shell',
        reject: false,
        scope: 'session',
        continue: true,
        instructions: undefined,
      }),
    );
  });

  it('posts always scope when Always is confirmed', async () => {
    renderWithQc(
      <MutationDiffCards sessionId="wb_1" status={shellStatus} />,
    );
    fireEvent.click(screen.getByTestId('permission-choice-always'));
    fireEvent.click(screen.getByTestId('permission-confirm'));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/workbench/confirm-mutation', {
        sessionId: 'wb_1',
        token: 'tok_shell',
        reject: false,
        scope: 'always',
        continue: true,
        instructions: undefined,
      }),
    );
  });

  it('never offers Always for a destructive pending command', () => {
    renderWithQc(
      <MutationDiffCards
        sessionId="wb_1"
        status={{
          ...shellStatus,
          pendingArgs: { command: 'rm -rf build' },
          pendingCategories: ['destructive'],
        }}
      />,
    );
    expect(screen.queryByTestId('permission-choice-always')).not.toBeInTheDocument();
    expect(screen.getByTestId('permission-choice-session')).toBeInTheDocument();
    expect(screen.getByTestId('permission-always-withheld')).toBeInTheDocument();
  });

  it('never offers Always for a network pending command', () => {
    renderWithQc(
      <MutationDiffCards
        sessionId="wb_1"
        status={{
          ...shellStatus,
          pendingArgs: { command: 'git push --force' },
          pendingCategories: ['network'],
        }}
      />,
    );
    expect(screen.queryByTestId('permission-choice-always')).not.toBeInTheDocument();
  });

  it('never offers Always when the backend sent a broad grant key', () => {
    renderWithQc(
      <MutationDiffCards
        sessionId="wb_1"
        status={{ ...shellStatus, pendingGrantKey: 'run_terminal_cmd:*' }}
      />,
    );
    expect(screen.queryByTestId('permission-choice-always')).not.toBeInTheDocument();
  });

  it('posts reject when Deny is confirmed', async () => {
    renderWithQc(
      <MutationDiffCards sessionId="wb_1" status={shellStatus} />,
    );
    fireEvent.click(screen.getByTestId('permission-choice-deny'));
    fireEvent.click(screen.getByTestId('permission-confirm'));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/workbench/confirm-mutation', {
        sessionId: 'wb_1',
        token: 'tok_shell',
        reject: true,
        scope: 'once',
        continue: true,
        instructions: undefined,
      }),
    );
  });

  it('posts reject with instructions when the free-form option is confirmed', async () => {
    renderWithQc(
      <MutationDiffCards sessionId="wb_1" status={shellStatus} />,
    );
    fireEvent.click(screen.getByTestId('permission-choice-instructions'));
    fireEvent.change(screen.getByTestId('permission-instructions-input'), {
      target: { value: 'Use --stat instead' },
    });
    fireEvent.click(screen.getByTestId('permission-confirm'));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/workbench/confirm-mutation', {
        sessionId: 'wb_1',
        token: 'tok_shell',
        reject: true,
        scope: 'once',
        continue: true,
        instructions: 'Use --stat instead',
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
        'old_string': 'foo',
        'new_string': 'bar',
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
