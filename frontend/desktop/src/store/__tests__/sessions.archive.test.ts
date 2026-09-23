/* Archive used to be a localStorage-only flag, and the sidebar action that
 * looked like archiving once *deleted* the session server-side. The backend now
 * owns an `is_archived` column, so the store has to keep it in sync — without
 * letting the network decide whether the click worked. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('keeps the local archive when the backend write fails', async () => {
    setManageSessionArchived.mockRejectedValue(new Error('backend offline'));
    const id = seed();

    archiveSession(id);
    await Promise.resolve();

    expect($sessions.get().find((s) => s.id === id)?.isArchived).toBe(true);
  });
});
