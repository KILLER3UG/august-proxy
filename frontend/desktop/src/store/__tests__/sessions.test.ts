/* ── sessions.test.ts ─ folder-creation & session-grouping regression tests ─ */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  $sessions,
  $folders,
  findOrCreateSessionForPath,
  bindSessionToWorkspacePath,
  createFolder,
  createSession,
  createEmptySessionInFolder,
  getOrCreateEmptySession,
  saveSessionsToStorage,
  saveFoldersToStorage,
  dedupeSessions,
  preferSessionRow,
  updateSessionWorkbenchMetadata,
  reconcileSessionsFromBackend,
  type Session,
} from '../sessions';

vi.mock('@/api/workbench', () => ({
  getWorkbenchSessions: vi.fn(() => Promise.resolve([])),
  deleteWorkbenchSession: vi.fn(() => Promise.resolve()),
}));

import { getWorkbenchSessions } from '@/api/workbench';

beforeEach(() => {
  // Reset both stores to a clean slate before each test.
  $sessions.set([]);
  $folders.set([]);
  saveSessionsToStorage([]);
  saveFoldersToStorage([]);
  vi.mocked(getWorkbenchSessions).mockReset();
  vi.mocked(getWorkbenchSessions).mockResolvedValue([]);
});

describe('bindSessionToWorkspacePath', () => {
  it('creates a Repositories folder for a new path and groups the session', () => {
    const session = createSession(null, 'Chat', null);
    expect(session.folderId).toBeNull();

    const { session: bound, folderCreated } = bindSessionToWorkspacePath(
      session.id,
      'C:\\Dev\\other-project',
      'other-project',
    );

    expect(bound.id).toBe(session.id);
    expect(folderCreated).toBe(true);
    const folders = $folders.get();
    expect(folders).toHaveLength(1);
    expect(folders[0].workspacePath).toBe('C:/Dev/other-project');
    const updated = $sessions.get().find((s) => s.id === session.id);
    expect(updated?.folderId).toBe(folders[0].id);
    expect(updated?.workspacePath).toBe('C:/Dev/other-project');
  });

  it('keeps the current session when another chat already owns the path', () => {
    const existing = createSession(null, 'Older', 'C:/Dev/shared');
    const current = createSession(null, 'Current', null);

    const { session: bound, folderCreated } = bindSessionToWorkspacePath(
      current.id,
      'C:/Dev/shared',
      'shared',
    );

    expect(bound.id).toBe(current.id);
    expect(folderCreated).toBe(true);
    const folder = $folders.get().find((f) => f.workspacePath === 'C:/Dev/shared')!;
    expect($sessions.get().find((s) => s.id === current.id)?.folderId).toBe(folder.id);
    expect($sessions.get().find((s) => s.id === existing.id)?.folderId).toBe(folder.id);
  });

  it('reuses an existing Repositories folder for the same path', () => {
    const first = createSession(null, 'A', null);
    bindSessionToWorkspacePath(first.id, 'C:/Dev/proj', 'proj');
    const folderId = $folders.get()[0].id;

    const second = createSession(null, 'B', null);
    const { folderCreated } = bindSessionToWorkspacePath(second.id, 'C:/Dev/proj', 'proj');

    expect(folderCreated).toBe(false);
    expect($folders.get()).toHaveLength(1);
    expect($sessions.get().find((s) => s.id === second.id)?.folderId).toBe(folderId);
  });

  it('binds by workbenchSessionId without creating a ghost Project session', () => {
    const session = createSession(null, 'Chat', null);
    updateSessionWorkbenchMetadata(session.id, { workbenchSessionId: 'wb_test_1' });

    const { session: bound, created } = bindSessionToWorkspacePath(
      'wb_test_1',
      'C:/Dev/bound-wb',
      'bound-wb',
    );

    expect(created).toBe(false);
    expect(bound.id).toBe(session.id);
    expect($sessions.get().filter((s) => s.title.startsWith('Project:'))).toHaveLength(0);
    expect($sessions.get().find((s) => s.id === session.id)?.folderId).toBeTruthy();
  });
});

describe('findOrCreateSessionForPath — new folder path', () => {
  it('creates a folder entry tracking the workspacePath', () => {
    const { session, created } = findOrCreateSessionForPath(
      'C:/Dev/my-project',
      'my-project',
    );

    expect(created).toBe(true);
    const folders = $folders.get();
    expect(folders).toHaveLength(1);
    expect(folders[0].workspacePath).toBe('C:/Dev/my-project');
    expect(folders[0].name).toBe('my-project');
    // The session is associated with the folder (not uncategorized).
    expect(session.folderId).toBe(folders[0].id);
    expect(session.workspacePath).toBe('C:/Dev/my-project');
  });

  it('derives the folder name from the path when not provided', () => {
    const { session } = findOrCreateSessionForPath('/home/user/cool-app');
    const folders = $folders.get();
    expect(folders[0].name).toBe('cool-app');
    expect(session.title).toBe('Project: cool-app');
  });

  it('normalizes Windows backslashes in the stored path', () => {
    // Single backslashes, as Tauri's select_directory returns on Windows.
    const { session } = findOrCreateSessionForPath('C:\\Dev\\proj');
    expect(session.workspacePath).toBe('C:/Dev/proj');
    expect($folders.get()[0].workspacePath).toBe('C:/Dev/proj');
  });
});

describe('findOrCreateSessionForPath — existing path (idempotent)', () => {
  it('switches to the existing session without duplicating folder/session', () => {
    const first = findOrCreateSessionForPath('/repos/app', 'app');
    const foldersBefore = $folders.get().length;
    const sessionsBefore = $sessions.get().length;

    const second = findOrCreateSessionForPath('/repos/app', 'app');

    expect(second.created).toBe(false);
    expect(second.session.id).toBe(first.session.id);
    // No new folder or session was created.
    expect($folders.get()).toHaveLength(foldersBefore);
    expect($sessions.get()).toHaveLength(sessionsBefore);
  });

  it('reuses the existing folder even if called with a different name', () => {
    findOrCreateSessionForPath('/repos/app', 'app');
    const originalFolderId = $folders.get()[0].id;

    const second = findOrCreateSessionForPath('/repos/app', 'different-name');

    // Same folder (matched by path, not name).
    expect($folders.get()).toHaveLength(1);
    expect($folders.get()[0].id).toBe(originalFolderId);
    expect(second.session.folderId).toBe(originalFolderId);
  });
});

describe('findOrCreateSessionForPath — grouping orphan sessions', () => {
  it('re-parents an existing session sharing the path into the folder', () => {
    // An orphan session created directly (no folder) but sharing the path.
    const orphan = createSession(null, 'Orphan', '/repos/app');
    expect(orphan.folderId).toBeNull();

    // Now select that folder path — the orphan should be grouped under it.
    findOrCreateSessionForPath('/repos/app', 'app');

    const folder = $folders.get().find((f) => f.workspacePath === '/repos/app')!;
    expect(folder).toBeTruthy();

    const updatedOrphan = $sessions.get().find((s) => s.id === orphan.id)!;
    expect(updatedOrphan.folderId).toBe(folder.id);
  });

  it('does not move sessions with a different workspacePath', () => {
    const other = createSession(null, 'Other', '/repos/different');
    findOrCreateSessionForPath('/repos/app', 'app');

    const updatedOther = $sessions.get().find((s) => s.id === other.id)!;
    expect(updatedOther.folderId).toBeNull();
  });
});

describe('createFolder — manual (no path)', () => {
  it('creates a folder with workspacePath null (never auto-matched)', () => {
    const folder = createFolder('My Notes');
    expect(folder.workspacePath).toBeNull();
    expect($folders.get()).toContainEqual(folder);

    // Selecting a real path must NOT match this manual folder.
    findOrCreateSessionForPath('/some/path', 'path');
    expect($folders.get().filter((f) => f.workspacePath === null)).toHaveLength(1);
    expect($folders.get().filter((f) => f.workspacePath === '/some/path')).toHaveLength(1);
  });
});

describe('getOrCreateEmptySession — no blank stacking', () => {
  it('reuses an existing empty session instead of creating another', () => {
    const first = getOrCreateEmptySession(null, 'Chat A');
    const second = getOrCreateEmptySession(null, 'Chat B');
    expect(second.id).toBe(first.id);
    expect($sessions.get()).toHaveLength(1);
  });

  it('creates a new session when the only session already has messages', () => {
    const first = createSession(null, 'Busy');
    // Simulate used chat
    $sessions.set([{ ...first, messageCount: 3 }]);
    saveSessionsToStorage($sessions.get());
    const second = getOrCreateEmptySession(null, 'Fresh');
    expect(second.id).not.toBe(first.id);
    expect($sessions.get()).toHaveLength(2);
  });
});

describe('createEmptySessionInFolder — Codex-style multi-chat per project', () => {
  it('keeps sessions visible in every folder (sidebar must not filter by current workspace)', () => {
    // Regression: filtering SessionList by currentWorkspacePath made other
    // Repositories folders look empty until you switched back.
    const folderA = createFolder('proj-a', 'C:/Dev/proj-a');
    const folderB = createFolder('proj-b', 'C:/Dev/proj-b');
    const sessA = createEmptySessionInFolder(folderA.id, 'A chat');
    $sessions.set([{ ...sessA, messageCount: 2 }]);
    saveSessionsToStorage($sessions.get());
    const sessB = createEmptySessionInFolder(folderB.id, 'B chat');

    const visible = $sessions.get().filter((s) => !s.isArchived);
    const inA = visible.filter((s) => s.folderId === folderA.id);
    const inB = visible.filter((s) => s.folderId === folderB.id);
    expect(inA.map((s) => s.id)).toContain(sessA.id);
    expect(inB.map((s) => s.id)).toContain(sessB.id);
    // Switching "current workspace" must not drop the other folder's rows.
    expect(inA).toHaveLength(1);
    expect(inB).toHaveLength(1);
  });

  it('creates a new chat under the folder with the folder workspace path', () => {
    const folder = createFolder('august-proxy', 'C:/Dev/august-proxy');
    const first = createEmptySessionInFolder(folder.id, 'Chat 1');
    expect(first.folderId).toBe(folder.id);
    expect(first.workspacePath).toBe('C:/Dev/august-proxy');

    // Mark first as used so a second empty chat can be created.
    $sessions.set([{ ...first, messageCount: 2 }]);
    saveSessionsToStorage($sessions.get());

    const second = createEmptySessionInFolder(folder.id, 'Chat 2');
    expect(second.id).not.toBe(first.id);
    expect(second.folderId).toBe(folder.id);
    expect(second.workspacePath).toBe('C:/Dev/august-proxy');
    expect($sessions.get().filter((s) => s.folderId === folder.id)).toHaveLength(2);
  });

  it('reuses an empty chat in the same folder instead of stacking blanks', () => {
    const folder = createFolder('proj', '/repos/proj');
    const first = createEmptySessionInFolder(folder.id);
    const second = createEmptySessionInFolder(folder.id);
    expect(second.id).toBe(first.id);
    expect($sessions.get()).toHaveLength(1);
  });
});

describe('dedupeSessions — sess_* + wb_* pairs', () => {
  const base = (partial: Partial<Session> & Pick<Session, 'id' | 'title'>): Session => ({
    startedAt: new Date().toISOString(),
    messageCount: 0,
    lastMessage: '',
    provider: '',
    model: '',
    isArchived: false,
    ...partial,
  });

  it('merges local sess row with standalone workbench row', () => {
    const local = base({
      id: 'sess_20260715_120000_abcd',
      title: 'My chat',
      workbenchSessionId: 'wb_abc',
      messageCount: 2,
    });
    const remote = base({
      id: 'wb_abc',
      title: 'New Session',
      workbenchSessionId: 'wb_abc',
      messageCount: 0,
    });
    const out = dedupeSessions([local, remote]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(local.id);
    expect(out[0].workbenchSessionId).toBe('wb_abc');
    expect(out[0].title).toBe('My chat');
    expect(out[0].messageCount).toBe(2);
  });

  it('preferSessionRow keeps sess_* id', () => {
    const a = base({ id: 'wb_x', title: 'New Session', workbenchSessionId: 'wb_x' });
    const b = base({ id: 'sess_y', title: 'Hello world', workbenchSessionId: 'wb_x' });
    const m = preferSessionRow(a, b);
    expect(m.id).toBe('sess_y');
    expect(m.workbenchSessionId).toBe('wb_x');
    expect(m.title).toBe('Hello world');
  });

  it('updateSessionWorkbenchMetadata collapses a pre-existing wb row', () => {
    const local = createSession(null, 'Draft');
    // Simulate SSE inserting workbench row first
    $sessions.set([
      base({ id: 'wb_race', title: 'New Session', workbenchSessionId: 'wb_race' }),
      ...$sessions.get(),
    ]);
    expect($sessions.get()).toHaveLength(2);

    updateSessionWorkbenchMetadata(local.id, { workbenchSessionId: 'wb_race' });

    const all = $sessions.get();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(local.id);
    expect(all[0].workbenchSessionId).toBe('wb_race');
  });
});

describe('reconcileSessionsFromBackend — keep drafts, stable ids', () => {
  it('keeps local-only empty sessions when backend list is empty', async () => {
    const draft = createSession(null, 'Chat 2026-07-15 12:00');
    vi.mocked(getWorkbenchSessions).mockResolvedValue([]);

    await reconcileSessionsFromBackend();

    const all = $sessions.get();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(draft.id);
  });

  it('does not rewrite local id to workbench id on match', async () => {
    const local = createSession(null, 'Important title');
    $sessions.set([{ ...local, workbenchSessionId: 'wb_keep', messageCount: 1 }]);
    saveSessionsToStorage($sessions.get());

    vi.mocked(getWorkbenchSessions).mockResolvedValue([
      {
        id: 'wb_keep',
        title: 'New Session',
        provider: 'openai',
        model: 'gpt',
        messageCount: 1,
        updatedAt: new Date().toISOString(),
      } as never,
    ]);

    await reconcileSessionsFromBackend();

    const all = $sessions.get();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(local.id); // still sess_*
    expect(all[0].workbenchSessionId).toBe('wb_keep');
    expect(all[0].title).toBe('Important title');
  });

  it('drops local rows whose workbench id was deleted server-side', async () => {
    const local = createSession(null, 'Gone');
    $sessions.set([{ ...local, workbenchSessionId: 'wb_deleted', messageCount: 3 }]);
    saveSessionsToStorage($sessions.get());
    vi.mocked(getWorkbenchSessions).mockResolvedValue([]);

    await reconcileSessionsFromBackend();

    expect($sessions.get()).toHaveLength(0);
  });

  it('attaches backend-only session to a pending empty local draft', async () => {
    const draft = createSession(null, 'Chat 2026-07-15 12:00');
    vi.mocked(getWorkbenchSessions).mockResolvedValue([
      {
        id: 'wb_new',
        title: 'New Session',
        provider: 'x',
        messageCount: 0,
        updatedAt: new Date().toISOString(),
      } as never,
    ]);

    await reconcileSessionsFromBackend();

    const all = $sessions.get();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(draft.id);
    expect(all[0].workbenchSessionId).toBe('wb_new');
  });
});
