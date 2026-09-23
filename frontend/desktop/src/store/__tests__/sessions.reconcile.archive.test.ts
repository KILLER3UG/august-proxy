/* Archived sessions must survive a wiped localStorage.

The archive flag is durable server-side (`sessions.is_archived`), and the
sidebar writes it on click — but the sidebar itself is rebuilt from the
workbench list, so unless that list carries the flag every archived chat comes
back on a fresh profile. These tests pin the read half of that loop, and the
rule that nothing else about a row is taken from the server. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  $sessions,
  createSession,
  reconcileSessionsFromBackend,
  updateSessionWorkbenchMetadata,
} from '../sessions';
import { saveSessionsToStorage } from '../sessions/storage';
import type { Session } from '../sessions/types';

const getWorkbenchSessions = vi.fn((): Promise<unknown[]> => Promise.resolve([]));

vi.mock('@/api/workbench', () => ({
  getWorkbenchSessions: (): Promise<unknown[]> => getWorkbenchSessions(),
  deleteWorkbenchSession: vi.fn(() => Promise.resolve()),
  stopWorkbenchChat: vi.fn(() => Promise.resolve(undefined)),
}));

function backendRow(overrides: Record<string, unknown>): void {
  getWorkbenchSessions.mockResolvedValue([overrides]);
}

function row(id: string): Session | undefined {
  return $sessions.get().find((s) => s.id === id);
}

beforeEach(() => {
  getWorkbenchSessions.mockReset();
  getWorkbenchSessions.mockResolvedValue([]);
  $sessions.set([]);
  saveSessionsToStorage([]);
});

describe('archive hydration', () => {
  it('applies the server flag to a linked local row', async () => {
    const local = createSession(null, 'Old chat', null);
    updateSessionWorkbenchMetadata(local.id, { workbenchSessionId: 'wb_1' });
    backendRow({ id: 'wb_1', title: 'Old chat', provider: 'p', messageCount: 3, isArchived: true });

    await reconcileSessionsFromBackend();

    expect(row(local.id)?.isArchived).toBe(true);
  });

  it('leaves the local value alone when the server has no opinion', async () => {
    const local = createSession(null, 'Kept', null);
    updateSessionWorkbenchMetadata(local.id, { workbenchSessionId: 'wb_2' });
    $sessions.set($sessions.get().map((s) => (s.id === local.id ? { ...s, isArchived: true } : s)));
    backendRow({ id: 'wb_2', title: 'Kept', provider: 'p', messageCount: 3 });

    await reconcileSessionsFromBackend();

    expect(row(local.id)?.isArchived).toBe(true);
  });

  it('restores an archived flag for a row the local index no longer has', async () => {
    // The localStorage-wipe case: the sidebar is rebuilt from the backend, and
    // without the flag the chat silently reappears in the list.
    backendRow({ id: 'wb_3', title: 'Parked chat', provider: 'p', messageCount: 9, isArchived: 1 });

    await reconcileSessionsFromBackend();

    expect(row('wb_3')?.isArchived).toBe(true);
  });

  it('takes the flag and nothing else — id, title and path stay local', async () => {
    const local = createSession(null, 'My own title', 'C:/Dev/keep-me');
    updateSessionWorkbenchMetadata(local.id, { workbenchSessionId: 'wb_4' });
    backendRow({
      id: 'wb_4',
      title: 'Backend placeholder',
      provider: 'p',
      model: 'm',
      messageCount: 2,
      workspacePath: 'C:/Dev/other',
      isArchived: true,
    });

    await reconcileSessionsFromBackend();

    const merged = row(local.id);
    expect(merged?.id).toBe(local.id);
    expect(merged?.title).toBe('My own title');
    expect(merged?.workspacePath).toBe('C:/Dev/keep-me');
    expect(merged?.isArchived).toBe(true);
  });
});
