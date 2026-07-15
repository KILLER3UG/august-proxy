/* ── sessions.test.ts ─ folder-creation & session-grouping regression tests ─ */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  $sessions,
  $folders,
  findOrCreateSessionForPath,
  createFolder,
  createSession,
  getOrCreateEmptySession,
  saveSessionsToStorage,
  saveFoldersToStorage,
} from '../sessions';

beforeEach(() => {
  // Reset both stores to a clean slate before each test.
  $sessions.set([]);
  $folders.set([]);
  saveSessionsToStorage([]);
  saveFoldersToStorage([]);
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
