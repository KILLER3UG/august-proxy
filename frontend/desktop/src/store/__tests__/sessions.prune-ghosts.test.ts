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

  it('keeps a row holding an UNSENT COMPOSER DRAFT — the sweep is never destructive', () => {
    /* The one thing no transcript key shows: text typed into the composer and
     * never sent. The store clears `august_composer_draft_<id>` for every row
     * it sweeps, so without this guard a day-old blank chat holding someone's
     * half-written message loses both the row and the words. */
    const s = ghost();
    localStorage.setItem(`august_composer_draft_${s.id}`, 'the thing I meant to ask');
    const { kept, removed } = pruneGhostSessions([s], { now: NOW });
    expect(removed).toEqual([]);
    expect(kept.map((x) => x.id)).toEqual(['sess_ghost_1']);
    expect(localStorage.getItem(`august_composer_draft_${s.id}`)).toBe(
      'the thing I meant to ask',
    );
  });

  it('still sweeps when the stored draft is blank or whitespace-only', () => {
    /* `persistComposerDraft` writes the raw string, so an emptied composer
     * leaves '' behind rather than removing the key. A blank draft is not
     * content and must not keep a ghost alive forever. */
    const blank = ghost({ id: 'sess_ghost_1' });
    const spaces = ghost({ id: 'sess_ghost_2' });
    localStorage.setItem(`august_composer_draft_${blank.id}`, '');
    localStorage.setItem(`august_composer_draft_${spaces.id}`, '\n   \n');
    const { removed } = pruneGhostSessions([blank, spaces], { now: NOW });
    expect(removed.map((s) => s.id).sort()).toEqual(['sess_ghost_1', 'sess_ghost_2']);
  });
});

/* Both cases import the store MODULE, which pulls the whole chat/api graph   *
 * through vite's transform on a cold cache — measured 13.8s here, against a   *
 * 5s default. That is test-harness cost, not boot cost, so the budget is      *
 * raised per test rather than globally. */                                     
const BOOT_IMPORT_MS = 30_000;

describe('pruneGhostSessions — store boot integration', () => {
  it('the sessions store boots with the pruned list and rewrites storage', { timeout: BOOT_IMPORT_MS }, async () => {
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

  it('boot clears draft storage only for rows it proves blank — never the words', { timeout: BOOT_IMPORT_MS }, async () => {
    /* Pins the WIRING, not just the predicate: the store's own cleanup loop is
     * what deletes draft keys, so a guard inside pruneGhostSessions is only
     * safe while both read the same key. One ghost with a draft, one without. */
    localStorage.clear();
    const drafted = ghost({ id: 'sess_ghost_1' });
    const blank = ghost({ id: 'sess_ghost_2' });
    localStorage.setItem(
      'august-sessions-list-v1',
      JSON.stringify([drafted, blank, ghost({ id: 'sess_real_1', title: 'Real conversation' })]),
    );
    localStorage.setItem('august_composer_draft_sess_ghost_1', 'unsent words');
    localStorage.setItem('august_composer_draft_sess_ghost_2', '');
    vi.resetModules();
    const store = await import('../sessions');
    const ids = store.useSessionsStore.getState().sessions.map((s) => s.id);
    expect(ids).toEqual(['sess_ghost_1', 'sess_real_1']);
    expect(localStorage.getItem('august_composer_draft_sess_ghost_1')).toBe('unsent words');
    expect(localStorage.getItem('august_composer_draft_sess_ghost_2')).toBeNull();
  });
});
