/* ── Durable multi-agent kanban board ─────────────────────────────────── */

import { useEffect, useState } from 'react';
import { Kanban, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  useKanbanStore,
  KANBAN_COLUMNS,
  type KanbanCard,
  type KanbanColumnId,
} from '@/store/kanban-board';

export function KanbanSection() {
  const hydrate = useKanbanStore((s) => s.hydrate);
  const cards = useKanbanStore((s) => s.cards);
  const addCard = useKanbanStore((s) => s.addCard);
  const moveCard = useKanbanStore((s) => s.moveCard);
  const removeCard = useKanbanStore((s) => s.removeCard);
  const clearDone = useKanbanStore((s) => s.clearDone);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const onAdd = () => {
    if (!draft.trim()) return;
    addCard(draft.trim(), 'backlog');
    setDraft('');
  };

  return (
    <div className="px-8 py-6 space-y-4 h-full flex flex-col" data-testid="kanban-section">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Kanban className="size-5 text-primary" />
            Agent board
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Durable kanban across agents and jobs — persisted in this browser.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onAdd();
            }}
            placeholder="New card title…"
            className="w-56 rounded-md border border-white/[0.08] bg-white/[0.06] px-2.5 py-1.5 text-xs"
          />
          <Button size="sm" onClick={onAdd}>
            <Plus className="size-3" /> Add
          </Button>
          <Button size="sm" variant="outline" onClick={clearDone}>
            <Trash2 className="size-3" /> Clear done
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 overflow-auto">
        {KANBAN_COLUMNS.map((col) => (
          <Column
            key={col.id}
            id={col.id}
            label={col.label}
            cards={cards.filter((c) => c.column === col.id)}
            onMove={moveCard}
            onRemove={removeCard}
          />
        ))}
      </div>
    </div>
  );
}

function Column({
  id,
  label,
  cards,
  onMove,
  onRemove,
}: {
  id: KanbanColumnId;
  label: string;
  cards: KanbanCard[];
  onMove: (id: string, column: KanbanColumnId) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="flex min-h-[12rem] flex-col rounded-xl border border-white/[0.08] bg-black/20">
      <div className="border-b border-white/[0.06] px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label} · {cards.length}
      </div>
      <ul className="flex-1 space-y-2 p-2 overflow-auto">
        {cards.map((card) => (
          <li
            key={card.id}
            className="rounded-lg border border-white/[0.08] bg-card/40 p-2 text-xs shadow-sm"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/kanban-id', card.id);
            }}
          >
            <div className="flex items-start justify-between gap-1">
              <span className="font-medium text-foreground/90">{card.title}</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(card.id)}
                aria-label="Remove card"
              >
                <X className="size-3" />
              </button>
            </div>
            {card.agentId && (
              <div className="mt-1 text-[10px] text-muted-foreground">agent: {card.agentId}</div>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              {KANBAN_COLUMNS.filter((c) => c.id !== id).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] border border-white/[0.08] hover:bg-white/[0.06]',
                  )}
                  onClick={() => onMove(card.id, c.id)}
                >
                  → {c.label}
                </button>
              ))}
            </div>
          </li>
        ))}
        {cards.length === 0 && (
          <li
            className="rounded-lg border border-dashed border-white/[0.06] p-3 text-center text-[11px] text-muted-foreground"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const cardId = e.dataTransfer.getData('text/kanban-id');
              if (cardId) onMove(cardId, id);
            }}
          >
            Drop cards here
          </li>
        )}
      </ul>
    </div>
  );
}

export default KanbanSection;
