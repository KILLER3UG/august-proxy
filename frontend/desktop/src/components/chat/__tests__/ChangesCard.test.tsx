import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChangesCard } from '../ChangesCard';
import type { GitDiffFile, GitDiffResult } from '@/api/git';
import type { MessageBlock } from '@/types/chat';
import {
  listWorkbenchCheckpoints,
  restoreWorkbenchCheckpoint,
} from '@/api/workbench';
import { gitApi } from '@/api/git';
import {
  openRightDrawer,
  setRightDrawerDiff,
  openRightDrawerFile,
} from '@/components/shell/RightDrawerState';
import { ChatAttachmentService } from '@/sections/chat/services/ChatAttachmentService';
import { revealInFolder } from '@/lib/tauri-shell';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/workbench', () => ({
  listWorkbenchCheckpoints: vi.fn(),
  restoreWorkbenchCheckpoint: vi.fn(),
}));

vi.mock('@/api/git', () => ({
  gitApi: {
    command: vi.fn().mockResolvedValue({ workspace: null, output: '' }),
  },
}));

vi.mock('@/components/shell/RightDrawerState', () => ({
  openRightDrawer: vi.fn(),
  setRightDrawerDiff: vi.fn(),
  openRightDrawerFile: vi.fn(),
}));

vi.mock('@/sections/chat/services/ChatAttachmentService', () => ({
  ChatAttachmentService: { fromPath: vi.fn(), fromBackendPath: vi.fn() },
}));

vi.mock('@/lib/tauri-shell', () => ({
  revealInFolder: vi.fn().mockResolvedValue(undefined),
}));

function editBlock(id: string, path: string): MessageBlock {
  return {
    id: `block_${id}`,
    type: 'toolCall',
    tool: {
      id,
      name: 'write_file',
      status: 'done',
      context: JSON.stringify({ path, content: 'x' }),
      summary: `Wrote ${path}`,
    },
  };
}

function diffFile(partial: Partial<GitDiffFile> & { path: string }): GitDiffFile {
  return { status: 'M', added: 0, removed: 0, diff: '', ...partial };
}

function diffResult(files: GitDiffFile[]): GitDiffResult {
  return {
    workspace: '/w',
    added: files.reduce((s, f) => s + f.added, 0),
    removed: files.reduce((s, f) => s + f.removed, 0),
    files,
  };
}

function renderCard(props: React.ComponentProps<typeof ChangesCard>) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/c/sess_test']}>
        <Routes>
          {/* Real app chat route (routes.ts) — ChangesCard falls back to the
              :sessionId param when no explicit sessionId prop is passed. */}
          <Route path="/c/:sessionId" element={<ChangesCard {...props} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const PY_DIFF = '@@ -1,1 +1,2 @@\n keep me\n+added line\n';

describe('ChangesCard (plan §4.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders null when both inputs are empty', () => {
    const { container } = renderCard({ blocks: [], changedFiles: null });
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('changes-card-header')).toBeNull();
  });

  it('shows header count from edit-tool blocks and totals from the git diff', () => {
    renderCard({
      blocks: [editBlock('a', 'app.py'), editBlock('b', 'util.py')],
      changedFiles: diffResult([
        diffFile({ path: 'app.py', added: 10, removed: 2 }),
        diffFile({ path: 'util.py', added: 5, removed: 1 }),
      ]),
    });
    const header = screen.getByTestId('changes-card-header');
    expect(header.textContent).toContain('2');
    expect(header.textContent).toContain('files changed');
    expect(screen.getByTestId('changes-card-added').textContent).toBe('+15 added');
    expect(screen.getByTestId('changes-card-removed').textContent).toBe('-3 removed');
  });

  it('omits totals until diff data exists', () => {
    renderCard({ blocks: [editBlock('a', 'app.py')], changedFiles: null });
    expect(screen.getByTestId('changes-card-header').textContent).toContain('1');
    expect(screen.queryByTestId('changes-card-added')).toBeNull();
    expect(screen.queryByTestId('changes-card-removed')).toBeNull();
  });

  it('expands to one row per file (≤3 paths default expanded)', () => {
    renderCard({
      blocks: [editBlock('a', 'app.py'), editBlock('b', 'util.py')],
      changedFiles: null,
    });
    expect(screen.getAllByTestId('changes-card-row')).toHaveLength(2);
  });

  it('code row with diff data shows Review + Open and per-file ±chips', () => {
    renderCard({
      blocks: [editBlock('a', 'app.py')],
      changedFiles: diffResult([diffFile({ path: 'app.py', added: 12, removed: 3, diff: PY_DIFF })]),
    });
    const row = document.querySelector('[data-style="code"]');
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain('app.py');
    expect(row!.textContent).toContain('+12');
    expect(row!.textContent).toContain('-3');
    expect(screen.getByTestId('changes-card-review')).toBeTruthy();
    expect(screen.getByTestId('changes-card-open')).toBeTruthy();
  });

  it('document row (.md) shows badge + kind label + single Open, no Review', () => {
    renderCard({ blocks: [editBlock('n', 'notes.md')], changedFiles: null });
    const row = document.querySelector('[data-style="document"]');
    expect(row).toBeTruthy();
    const badge = screen.getByTestId('document-badge');
    expect(badge.textContent).toBe('M↓');
    expect(badge).toHaveAttribute('data-tone', 'document');
    expect(row!.textContent).toContain('notes.md');
    expect(row!.textContent).toContain('Document · MD');
    expect(screen.getAllByTestId('changes-card-open')).toHaveLength(1);
    expect(screen.queryByTestId('changes-card-review')).toBeNull();
  });

  it('code file without diff data renders document-style (streaming, pre-diff)', () => {
    renderCard({ blocks: [editBlock('a', 'app.py')], changedFiles: null });
    expect(document.querySelector('[data-style="code"]')).toBeNull();
    const row = document.querySelector('[data-style="document"]');
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain('app.py');
  });

  it('Review opens the diff in the right drawer', () => {
    const changes = diffResult([diffFile({ path: 'app.py', added: 1, removed: 0, diff: PY_DIFF })]);
    renderCard({ blocks: [editBlock('a', 'app.py')], changedFiles: changes });
    fireEvent.click(screen.getByTestId('changes-card-review'));
    expect(setRightDrawerDiff).toHaveBeenCalledWith(changes, 'app.py');
    expect(openRightDrawer).toHaveBeenCalledWith('diff');
  });

  it('Open opens the file in the drawer viewer (reveal fallback)', async () => {
    vi.mocked(ChatAttachmentService.fromPath).mockResolvedValue(null);
    renderCard({ blocks: [editBlock('n', 'notes.md')], changedFiles: null });
    fireEvent.click(screen.getAllByTestId('changes-card-open')[0]);
    await waitFor(() => expect(revealInFolder).toHaveBeenCalledWith('notes.md'));
    expect(openRightDrawerFile).not.toHaveBeenCalled();
  });

  it('toggles the capped inline diff on a code row', () => {
    renderCard({
      blocks: [editBlock('a', 'app.py')],
      changedFiles: diffResult([diffFile({ path: 'app.py', added: 1, removed: 0, diff: PY_DIFF })]),
    });
    expect(screen.queryByTestId('changes-card-inline-diff')).toBeNull();
    // The DisclosureRow button (path pill) toggles the inline diff.
    const toggle = screen.getByRole('button', { name: /app\.py/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const panel = screen.getByTestId('changes-card-inline-diff');
    expect(panel.textContent).toContain('added line');
    fireEvent.click(toggle);
    expect(screen.queryByTestId('changes-card-inline-diff')).toBeNull();
  });

  it('Undo restores the latest checkpoint after confirm', async () => {
    vi.mocked(listWorkbenchCheckpoints).mockResolvedValue([{ id: 'cp_1' }] as never);
    vi.mocked(restoreWorkbenchCheckpoint).mockResolvedValue({ message: 'Restored' } as never);
    renderCard({
      blocks: [editBlock('a', 'app.py'), editBlock('b', 'util.py')],
      changedFiles: null,
    });
    fireEvent.click(screen.getByTestId('changes-card-undo'));
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog.textContent).toContain('Revert all 2 changed files back to the last save point?');
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() =>
      expect(restoreWorkbenchCheckpoint).toHaveBeenCalledWith('sess_test', 'cp_1'),
    );
    expect(gitApi.command).not.toHaveBeenCalled();
  });

  it('Undo falls back to git restore when no save point exists', async () => {
    vi.mocked(listWorkbenchCheckpoints).mockResolvedValue([]);
    renderCard({
      blocks: [editBlock('a', 'app.py'), editBlock('b', 'util.py')],
      changedFiles: null,
    });
    fireEvent.click(screen.getByTestId('changes-card-undo'));
    const dialog = await screen.findByTestId('confirm-dialog');
    expect(dialog.textContent).toContain(
      'No save point found. Discard changes to 2 tracked files with git restore?',
    );
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() =>
      expect(gitApi.command).toHaveBeenCalledWith(['restore', '--', '.'], 'sess_test'),
    );
    expect(restoreWorkbenchCheckpoint).not.toHaveBeenCalled();
  });

  it('caps rows at 8 and shows +N more', () => {
    const blocks = Array.from({ length: 10 }, (_, i) => editBlock(`f${i}`, `file${i}.py`));
    renderCard({ blocks, changedFiles: null });
    // 10 paths → collapsed by default (>3); expand first.
    fireEvent.click(screen.getByTestId('changes-card-header'));
    expect(screen.getAllByTestId('changes-card-row')).toHaveLength(8);
    expect(screen.getByTestId('changes-card-overflow').textContent).toBe('+2 more');
  });

  it('falls back to diff paths when no edit tool carried a path', () => {
    renderCard({
      blocks: [],
      changedFiles: diffResult([diffFile({ path: 'gen/report.py', added: 4, removed: 0, diff: PY_DIFF })]),
    });
    const header = screen.getByTestId('changes-card-header');
    expect(header.textContent).toContain('1');
    expect(document.querySelector('[data-style="code"]')!.textContent).toContain('gen/report.py');
  });

  it('explicit sessionId prop wins over the route param', async () => {
    vi.mocked(listWorkbenchCheckpoints).mockResolvedValue([]);
    renderCard({
      blocks: [editBlock('a', 'app.py')],
      changedFiles: null,
      sessionId: 'sess_explicit',
    });
    fireEvent.click(screen.getByTestId('changes-card-undo'));
    await screen.findByTestId('confirm-dialog');
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() =>
      expect(gitApi.command).toHaveBeenCalledWith(['restore', '--', '.'], 'sess_explicit'),
    );
  });
});
