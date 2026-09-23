/* Archive used to be a localStorage-only flag, and the sidebar action that
 * looked like archiving once *deleted* the session server-side. The backend now
 * owns an `is_archived` column, so the store has to keep it in sync — without
 * letting the network decide whether the click worked. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import {
  $sessions,
  archiveSession,
  createSession,
  restoreSession,
  updateSessionWorkbenchMetadata,
} from '../sessions';
import { saveSessionsToStorage } from '../sessions/storage';

const setManageSessionArchived = vi.fn(
  (_id: string, _archived: boolean): Promise<unknown> => Promise.resolve(undefined),
);

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/api-client', () => ({
  deleteManageSession: (): Promise<unknown> => Promise.resolve(undefined),
  setManageSessionArchived: (id: string, archived: boolean): Promise<unknown> =>
    setManageSessionArchived(id, archived),
}));
vi.mock('@/api/workbench', () => ({
  deleteWorkbenchSession: vi.fn(() => Promise.resolve()),
  getWorkbenchSessions: vi.fn(() => Promise.resolve([])),
  stopWorkbenchChat: vi.fn(() => Promise.resolve()),
}));

function seed(): string {
  return createSession(null, 'A chat', null).id;
}

/** The link a real chat gets once its first turn reaches the workbench. */
function link(id: string, workbenchSessionId: string) {
  updateSessionWorkbenchMetadata(id, { workbenchSessionId });
}

beforeEach(() => {
  setManageSessionArchived.mockReset();
  setManageSessionArchived.mockResolvedValue({ id: 'x', isArchived: true });
  vi.mocked(toast.warning).mockReset();
  $sessions.set([]);
  saveSessionsToStorage([]);
});

describe('archiveSession / restoreSession — server sync', () => {
  it('archives locally and writes the flag to the backend', () => {
    const id = seed();

    archiveSession(id);

    expect($sessions.get().find((s) => s.id === id)?.isArchived).toBe(true);
    expect(setManageSessionArchived).toHaveBeenCalledWith(id, true);
  });

  it('sends the workbench handle, because that is the server row key', () => {
    const id = seed();
    link(id, 'wb_123');

    archiveSession(id);

    const sent = setManageSessionArchived.mock.calls.map((c) => c[0]);
    expect(sent).toContain('wb_123');
  });

  it('restores with archived=false rather than a delete', () => {
    const id = seed();
    link(id, 'wb_123');
    archiveSession(id);
    setManageSessionArchived.mockClear();

    restoreSession(id);

    expect($sessions.get().find((s) => s.id === id)?.isArchived).toBe(false);
    expect(setManageSessionArchived).toHaveBeenCalledWith('wb_123', false);
  });

  it('never sends the same id twice for one click', () => {
    const id = seed();
    link(id, id);

    archiveSession(id);

    expect(setManageSessionArchived).toHaveBeenCalledTimes(1);
  });

  it('reverts the local archive and warns when every backend write fails', async () => {
    // Updated: this used to assert the flag is KEPT on failure. That encoded
    // the bug — a swallowed total failure left the sidebar archived while the
    // server row was not, so the next reconcile resurrected it.
    setManageSessionArchived.mockRejectedValue(new Error('backend offline'));
    const id = seed();

    archiveSession(id);
    await Promise.resolve();
    await Promise.resolve();

    expect($sessions.get().find((s) => s.id === id)?.isArchived).toBe(false);
    expect(toast.warning).toHaveBeenCalled();
  });

  it('keeps the local archive when only the non-key candidate fails', async () => {
    // Two candidates (ui id + workbench id): one 404s because it is not the
    // server key, the other succeeds — that is a successful write, not a
    // failure, so the optimistic flag must stand.
    const id = seed();
    link(id, 'wb_123');
    setManageSessionArchived.mockImplementation((sent: string) =>
      sent === 'wb_123'
        ? Promise.resolve({ id: sent, isArchived: true })
        : Promise.reject(new Error('not found')),
    );

    archiveSession(id);
    await Promise.resolve();
    await Promise.resolve();

    expect($sessions.get().find((s) => s.id === id)?.isArchived).toBe(true);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('does not revert a flag the user already re-toggled while the push was in flight', async () => {
    // Only the archive write fails; the restore that follows lands. The stale
    // revert from the failed archive click must not clobber the newer value.
    const id = seed();
    setManageSessionArchived.mockImplementation((_sent: string, archived: boolean) =>
      archived
        ? Promise.reject(new Error('backend offline'))
        : Promise.resolve({ id: 'x', isArchived: false }),
    );

    archiveSession(id);
    restoreSession(id);
    await Promise.resolve();
    await Promise.resolve();

    expect($sessions.get().find((s) => s.id === id)?.isArchived).toBe(false);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
