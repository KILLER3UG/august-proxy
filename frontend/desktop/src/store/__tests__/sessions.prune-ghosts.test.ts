/* pruneGhostSessions — the launch-time ghost sweep.
 *
 * The pre-fix "New chat" reuse loop re-stamped an EMPTY session's startedAt on
 * every press, stacking 17 placeholder rows on top of real history. The sweep
 * is the residue removal, and its whole job is to be NARROW: every condition
 * must hold, and any doubt keeps the row. These tests pin the doubts. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pruneGhostSessions, sessionIsEmpty } from '../sessions/helpers';
import type { Session } from '../sessions/types';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function ghost(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess_ghost_1',
    title: 'New chat',
    startedAt: new Date(NOW - 3 * DAY).toISOString(),
    messageCount: 0,
    isArchived: false,
    folderId: null,
    workspacePath: null,
    ...overrides,
  } as Session;
}

describe('pruneGhostSessions', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('sweeps an old, empty, unlinked, unfiled placeholder row', () => {
    const { kept, removed } = pruneGhostSessions([ghost()], { now: NOW });
    expect(removed.map((s) => s.id)).toEqual(['sess_ghost_1']);
    expect(kept).toEqual([]);
  });

  it('keeps a fresh placeholder — the reuse pool findReusableEmptySession maintains', () => {
    const fresh = ghost({ startedAt: new Date(NOW - 60_000).toISOString() });
    const { kept, removed } = pruneGhostSessions([fresh], { now: NOW });
    expect(removed).toEqual([]);
    expect(kept.map((s) => s.id)).toEqual(['sess_ghost_1']);
  });

  it('keeps an unparseable startedAt — unprovable age, no deletion', () => {
    const { removed } = pruneGhostSessions([ghost({ startedAt: 'not-a-date' })], { now: NOW });
    expect(removed).toEqual([]);
  });

  it('keeps a session whose transcript lives under the LEGACY key', () => {
    // This is the exact shape the v2 rename nearly destroyed: a real
    // conversation whose messages are only readable at chat_messages_<id>.
    const s = ghost({ messageCount: 0 });
    localStorage.setItem(
      `chat_messages_${s.id}`,
      JSON.stringify([{ role: 'user', content: 'a real conversation' }]),
    );
    expect(sessionIsEmpty(s)).toBe(false);
    const { removed } = pruneGhostSessions([s], { now: NOW });
    expect(removed).toEqual([]);
  });

  it('keeps a session whose transcript lives under the v2 key', () => {
    const s = ghost();
    localStorage.setItem(
      `chat_messages_v2_${s.id}`,
      JSON.stringify([{ role: 'assistant', content: 'kept' }]),
    );
    const { removed } = pruneGhostSessions([s], { now: NOW });
    expect(removed).toEqual([]);
  });

  it('sweeps a v2 key holding an empty array — persistMessages writes that for a genuinely empty transcript', () => {
    const s = ghost();
    localStorage.setItem(`chat_messages_v2_${s.id}`, JSON.stringify([]));
    const { removed } = pruneGhostSessions([s], { now: NOW });
    expect(removed.map((x) => x.id)).toEqual(['sess_ghost_1']);
  });

  it('keeps a workbench-linked row even when it looks empty — the server owns it', () => {
    const s = ghost({ workbenchSessionId: 'wb_real' });
    const { removed } = pruneGhostSessions([s], { now: NOW });
    expect(removed).toEqual([]);
  });

  it('keeps filed and archived rows regardless of emptiness', () => {
    const filed = ghost({ folderId: 'folder_1' });
    const archived = ghost({ id: 'sess_ghost_2', isArchived: true });
    const { removed } = pruneGhostSessions([filed, archived], { now: NOW });
    expect(removed).toEqual([]);
  });

  it('keeps rows with a real title even when empty and old', () => {
    const s = ghost({ title: 'Quarterly planning notes' });
    const { removed } = pruneGhostSessions([s], { now: NOW });
    expect(removed).toEqual([]);
  });

  it('sweeps the date-stamped default titles too ("Chat 2026-07-15 14:30")', () => {
    const s = ghost({ title: 'Chat 2026-07-15 14:30' });
    const { removed } = pruneGhostSessions([s], { now: NOW });
    expect(removed.map((x) => x.id)).toEqual(['sess_ghost_1']);
  });
});

describe('pruneGhostSessions — store boot integration', () => {
  it('the sessions store boots with the pruned list and rewrites storage', async () => {
    // Seed BEFORE the store module loads: one ghost, one real row.
    localStorage.setItem(
      'august-sessions-list-v1',
      JSON.stringify([
        ghost(),
        ghost({ id: 'sess_real_1', title: 'Real conversation', startedAt: new Date(NOW - DAY).toISOString() }),
      ]),
    );
    vi.resetModules();
    const store = await import('../sessions');
    const sessions = store.useSessionsStore.getState().sessions;
    expect(sessions.map((s) => s.id)).toEqual(['sess_real_1']);
    // The pruned list is what the next save carries.
    expect(JSON.parse(localStorage.getItem('august-sessions-list-v1')!)).toHaveLength(1);
  });
});
