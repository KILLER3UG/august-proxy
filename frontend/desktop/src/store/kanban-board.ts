/* ── Durable kanban / multi-agent board ───────────────────────────────── */
/* Backed by /api/kanban (data/kanban.json), so the board is one shared store:
 * both windows that show it, the automations that spawn runs, and the `board`
 * tool an agent uses to claim a card read and write the same cards. It used to
 * be localStorage, which made the "across agents and jobs" claim in its own
 * header false — a card created in one window was invisible everywhere else,
 * and no agent could see the queue at all.
 *
 * Writes are optimistic and the server is authoritative: a rejected or
 * unreachable write re-reads the board instead of leaving the UI showing a
 * state that never existed. */

import { create } from 'zustand';
import { toast } from 'sonner';

export type KanbanColumnId = 'backlog' | 'doing' | 'review' | 'done';

export interface KanbanCard {
  id: string;
  title: string;
  body?: string;
  column: KanbanColumnId;
  agentId?: string;
  sessionId?: string;
  /** Sub-agent run task id (multi-agent teams) — lets the board track a
   *  card's live run status and auto-advance it on completion. */
  taskId?: string;
  createdAt: number;
  updatedAt: number;
}

interface KanbanState {
  cards: KanbanCard[];
  hydrated: boolean;
  hydrate: () => void;
  addCard: (title: string, column?: KanbanColumnId, meta?: Partial<KanbanCard>) => KanbanCard;
  moveCard: (id: string, column: KanbanColumnId) => void;
  updateCard: (id: string, patch: Partial<Pick<KanbanCard, 'title' | 'body' | 'agentId' | 'taskId' | 'sessionId'>>) => void;
  /** Human counterpart to an agent's `board(claim)`: set the owner without
   *  moving the card — assigning is not the same as starting. */
  assignCard: (id: string, agentId: string) => void;
  removeCard: (id: string) => void;
  clearDone: () => void;
}

const LEGACY_KEY = 'august-kanban-board-v1';
const IMPORTED_KEY = 'august-kanban-board-v1.imported';

const COLUMNS: KanbanColumnId[] = ['backlog', 'doing', 'review', 'done'];

function text(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return '';
}

function normalizeColumn(raw: unknown): KanbanColumnId {
  const col = text(raw).toLowerCase();
  return (COLUMNS as string[]).includes(col) ? (col as KanbanColumnId) : 'backlog';
}

function num(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : Date.now();
}

function toCard(raw: unknown): KanbanCard {
  const d = (raw ?? {}) as Record<string, unknown>;
  return {
    id: text(d.id),
    title: text(d.title),
    body: text(d.body) || undefined,
    column: normalizeColumn(d.column),
    agentId: text(d.agentId) || undefined,
    sessionId: text(d.sessionId) || undefined,
    taskId: text(d.taskId) || undefined,
    createdAt: num(d.createdAt),
    updatedAt: num(d.updatedAt),
  };
}

/** Parsed response body, or null when the request failed. */
async function call(path: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`/api/kanban${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.warn('[kanban] request failed', path, err);
    return null;
  }
}

function markImported(): void {
  try {
    localStorage.setItem(IMPORTED_KEY, '1');
  } catch {
    /* storage unavailable */
  }
}

/** Push a pre-existing browser board into the durable store, once. The
 *  localStorage copy is kept and only flagged, so a failed import retries on
 *  the next boot instead of having silently eaten someone's board. */
async function importLegacyOnce(): Promise<void> {
  try {
    if (localStorage.getItem(IMPORTED_KEY)) return;
  } catch {
    return;
  }
  let cards: unknown[] = [];
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    cards = Array.isArray(parsed) ? parsed : [];
  } catch {
    cards = [];
  }
  if (cards.length === 0) {
    markImported();
    return;
  }
  const res = await call('/import', { method: 'POST', body: JSON.stringify({ cards }) });
  if (res) markImported();
}

let inflight: Promise<void> | null = null;

export const useKanbanStore = create<KanbanState>((set, get) => {
  const apply = (cards: KanbanCard[]) => set({ cards });

  const refresh = async (): Promise<void> => {
    const res = await call('');
    if (!res) return;
    const raw = Array.isArray(res.cards) ? res.cards : [];
    apply(raw.map(toCard).sort((a, b) => b.createdAt - a.createdAt));
  };

  const lost = (what: string): void => {
    toast.error(`Board ${what} did not save`, {
      description: 'The backend is unreachable — the board has been re-read.',
    });
    void refresh();
  };

  const replace = (card: KanbanCard): void =>
    set((s) => ({ cards: s.cards.map((c) => (c.id === card.id ? card : c)) }));

  return {
    cards: [],
    hydrated: false,

    hydrate: () => {
      if (get().hydrated || inflight) return;
      inflight = (async () => {
        await importLegacyOnce();
        await refresh();
        set({ hydrated: true });
      })().finally(() => {
        inflight = null;
      });
    },

    addCard: (title, column = 'backlog', meta = {}) => {
      const ts = Date.now();
      // Placeholder id until the server's arrives, so the card is on screen the
      // moment the user presses Enter.
      const card: KanbanCard = {
        id: `tmp_${ts}_${Math.random().toString(36).slice(2, 6)}`,
        title: title.trim() || 'Untitled',
        body: meta.body,
        column,
        agentId: meta.agentId,
        sessionId: meta.sessionId,
        taskId: meta.taskId,
        createdAt: ts,
        updatedAt: ts,
      };
      set((s) => ({ cards: [card, ...s.cards] }));
      void (async () => {
        const res = await call('', {
          method: 'POST',
          body: JSON.stringify({
            title: card.title,
            column,
            body: card.body ?? '',
            agentId: card.agentId ?? '',
            sessionId: card.sessionId ?? '',
            taskId: card.taskId ?? '',
          }),
        });
        if (!res) {
          // Drop the placeholder rather than leave a card that exists nowhere.
          set((s) => ({ cards: s.cards.filter((c) => c.id !== card.id) }));
          lost('card');
          return;
        }
        const saved = toCard(res);
        // Swap by the placeholder's id: `saved.id` isn't in the list yet, so
        // matching on it would leave the placeholder on screen forever.
        set((s) => ({ cards: s.cards.map((c) => (c.id === card.id ? saved : c)) }));
      })();
      return card;
    },

    moveCard: (id, column) => {
      if (!COLUMNS.includes(column)) return;
      set((s) => ({
        cards: s.cards.map((c) => (c.id === id ? { ...c, column, updatedAt: Date.now() } : c)),
      }));
      void (async () => {
        const res = await call(`/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ column }),
        });
        if (!res) return lost('move');
        replace(toCard(res));
      })();
    },

    updateCard: (id, patch) => {
      set((s) => ({
        cards: s.cards.map((c) => (c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c)),
      }));
      void (async () => {
        const res = await call(`/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
        if (!res) return lost('edit');
        replace(toCard(res));
      })();
    },

    assignCard: (id, agentId) => {
      set((s) => ({
        cards: s.cards.map((c) => (c.id === id ? { ...c, agentId, updatedAt: Date.now() } : c)),
      }));
      void (async () => {
        const res = await call(`/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ agentId }),
        });
        if (!res) return lost('assignment');
        replace(toCard(res));
      })();
    },

    removeCard: (id) => {
      set((s) => ({ cards: s.cards.filter((c) => c.id !== id) }));
      void (async () => {
        const res = await call(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res) lost('delete');
      })();
    },

    clearDone: () => {
      set((s) => ({ cards: s.cards.filter((c) => c.column !== 'done') }));
      void (async () => {
        const res = await call('/clear-done', { method: 'POST' });
        if (!res) lost('clear');
      })();
    },
  };
});

export const KANBAN_COLUMNS: { id: KanbanColumnId; label: string }[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'doing', label: 'Doing' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];
