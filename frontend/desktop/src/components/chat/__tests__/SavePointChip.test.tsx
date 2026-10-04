import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SavePointChip } from '../SavePointChip';

const restore = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true, message: 'Restored 2 files' }));

vi.mock('@/api/workbench', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restoreWorkbenchCheckpoint: restore,
}));

function renderChip(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const CPTS = [
  { id: 'ck-2', createdAt: new Date('2026-10-04T10:00:05Z').toISOString(), label: 'Before edit', fileCount: 2 },
  { id: 'ck-1', createdAt: new Date('2026-10-04T10:00:01Z').toISOString(), label: 'Before write', fileCount: 1 },
];

describe('SavePointChip', () => {
  beforeEach(() => {
    restore.mockClear();
  });

  it('renders nothing for a turn with no save points (silence is the default)', () => {
    const { container } = renderChip(<SavePointChip checkpoints={[]} sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });

  it('counts the turn\'s save points', () => {
    renderChip(<SavePointChip checkpoints={CPTS} sessionId="s1" />);
    expect(screen.getByTestId('save-point-chip')).toHaveTextContent('2 save points');
    expect(screen.getByTestId('save-point-restore')).toBeInTheDocument();
  });

  it('singularizes one save point', () => {
    renderChip(<SavePointChip checkpoints={[CPTS[0]]} sessionId="s1" />);
    expect(screen.getByTestId('save-point-chip')).toHaveTextContent('1 save point');
  });

  it('confirms before restoring, then restores the EARLIEST checkpoint of the turn', async () => {
    renderChip(<SavePointChip checkpoints={CPTS} sessionId="s1" />);
    fireEvent.click(screen.getByTestId('save-point-restore'));

    // Nothing happens until the destructive restore is confirmed.
    await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
    expect(restore).not.toHaveBeenCalled();
    // The wording must say what will change and what will not.
    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent(/Rewind the workspace/);
    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent(/conversation stays as it is/);

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    // ck-1 is the earliest = the pre-turn state (the list arrives newest-first
    // from the backend, so "earliest" is the LAST element).
    await waitFor(() => expect(restore).toHaveBeenCalledWith('s1', 'ck-1'));
  });

  it('cancelling restores nothing', async () => {
    renderChip(<SavePointChip checkpoints={CPTS} sessionId="s1" />);
    fireEvent.click(screen.getByTestId('save-point-restore'));
    await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
    // Escape is the cancel gesture (one Escape closes one layer). Dispatch
    // on `document`, like a real key event: the dialog's Escape listener is
    // a document-CAPTURE listener, which an event dispatched directly at
    // `window` never reaches.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
    expect(restore).not.toHaveBeenCalled();
  });
});