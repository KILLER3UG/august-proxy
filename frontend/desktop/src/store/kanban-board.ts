/* ── Durable kanban / multi-agent board ───────────────────────────────── */
/* Persists across reloads via localStorage; optionally keyed by workspace. */

import { create } from 'zustand';

export type KanbanColumnId = 'backlog' | 'doing' | 'review' | 'done';

export interface KanbanCard {
  id: string;
  title: string;
  body?: string;
  column: KanbanColumnId;
  agentId?: string;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
}

interface KanbanState {
  cards: KanbanCard[];
  hydrated: boolean;
  hydrate: () => void;
  addCard: (title: string, column?: KanbanColumnId, meta?: Partial<KanbanCard>) => KanbanCard;
  moveCard: (id: string, column: KanbanColumnId) => void;
  updateCard: (id: string, patch: Partial<Pick<KanbanCard, 'title' | 'body' | 'agentId'>>) => void;
  removeCard: (id: string) => void;
  clearDone: () => void;
}

const STORAGE_KEY = 'august-kanban-board-v1';

const COLUMNS: KanbanColumnId[] = ['backlog', 'doing', 'review', 'done'];

function load(): KanbanCard[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as KanbanCard[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(cards: KanbanCard[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
  } catch {
    /* ignore */
  }
}

function uid() {
  return `kb_${Math.random().toString(36).slice(2, 10)}`;
}

export const useKanbanStore = create<KanbanState>((set, get) => ({
  cards: [],
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return;
    set({ cards: load(), hydrated: true });
  },

  addCard: (title, column = 'backlog', meta = {}) => {
    const ts = Date.now();
    const card: KanbanCard = {
      id: uid(),
      title: title.trim() || 'Untitled',
      body: meta.body,
      column,
      agentId: meta.agentId,
      sessionId: meta.sessionId,
      createdAt: ts,
      updatedAt: ts,
    };
    set((s) => {
      const cards = [card, ...s.cards];
      save(cards);
      return { cards };
    });
    return card;
  },

  moveCard: (id, column) => {
    if (!COLUMNS.includes(column)) return;
    set((s) => {
      const cards = s.cards.map((c) =>
        c.id === id ? { ...c, column, updatedAt: Date.now() } : c,
      );
      save(cards);
      return { cards };
    });
  },

  updateCard: (id, patch) => {
    set((s) => {
      const cards = s.cards.map((c) =>
        c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c,
      );
      save(cards);
      return { cards };
    });
  },

  removeCard: (id) => {
    set((s) => {
      const cards = s.cards.filter((c) => c.id !== id);
      save(cards);
      return { cards };
    });
  },

  clearDone: () => {
    set((s) => {
      const cards = s.cards.filter((c) => c.column !== 'done');
      save(cards);
      return { cards };
    });
  },
}));

export const KANBAN_COLUMNS: { id: KanbanColumnId; label: string }[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'doing', label: 'Doing' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];
