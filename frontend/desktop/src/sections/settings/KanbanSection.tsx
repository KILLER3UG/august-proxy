/* ── Durable multi-agent kanban board ─────────────────────────────────── */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, Kanban, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { listBots } from '@/api/api-client';
import { useSessionsStore } from '@/store/sessions';
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
  const assignCard = useKanbanStore((s) => s.assignCard);
  const clearDone = useKanbanStore((s) => s.clearDone);
  const [draft, setDraft] = useState('');
  // Agents attach a handoff note through the board tool; without a field here
  // the note is the one thing a person cannot write on a card.
  const [detail, setDetail] = useState('');
  const navigate = useNavigate();

  // Cards an agent claims carry the agent that owns them and the workbench
  // session that produced them; both are only useful if a human can see who
  // has the card and jump to that run.
  const { data: botsData } = useQuery({ queryKey: ['bots'], queryFn: () => listBots() });
  const agents = useMemo(
    () => (botsData?.bots ?? []).filter((b) => !b.uiMeta?.hidden),
    [botsData],
  );
  const sessions = useSessionsStore((s) => s.sessions);
  const sessionRouteFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      map.set(s.id, s.id);
      if (s.workbenchSessionId) map.set(s.workbenchSessionId, s.id);
    }
    return map;
  }, [sessions]);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const onAdd = () => {
    if (!draft.trim()) return;
    addCard(draft.trim(), 'backlog', { body: detail.trim() || undefined });
    setDraft('');
    setDetail('');
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
            Durable kanban across agents and jobs — the board an agent claims a
            card on is this one.
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
          <input
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onAdd();
            }}
            placeholder="Detail for whoever picks it up (optional)"
            aria-label="New card detail"
            className="w-72 rounded-md border border-white/[0.08] bg-white/[0.06] px-2.5 py-1.5 text-xs"
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
            onAssign={assignCard}
            agents={agents}
            onOpenSession={(workbenchSessionId) => {
              const ui = sessionRouteFor.get(workbenchSessionId);
              if (ui) void navigate(`/c/${ui}`);
            }}
            openableSessionIds={sessionRouteFor}
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
  agents,
  openableSessionIds,
  onMove,
  onRemove,
  onAssign,
  onOpenSession,
}: {
  id: KanbanColumnId;
  label: string;
  cards: KanbanCard[];
  agents: { id: string; name: string }[];
  openableSessionIds: Map<string, string>;
  onMove: (id: string, column: KanbanColumnId) => void;
  onRemove: (id: string) => void;
  onAssign: (id: string, agentId: string) => void;
  onOpenSession: (workbenchSessionId: string) => void;
}) {
  const [dropReady, setDropReady] = useState(false);
  return (
    <div
      className={cn(
        'flex min-h-[12rem] flex-col rounded-xl border border-white/[0.08] bg-black/20',
        dropReady && 'ring-1 ring-primary/50',
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDropReady(true);
      }}
      onDragLeave={() => setDropReady(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropReady(false);
        const cardId = e.dataTransfer.getData('text/kanban-id');
        if (cardId) onMove(cardId, id);
      }}
    >
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
            {card.body && (
              <div className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">
                {card.body}
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <select
                value={card.agentId ?? ''}
                onChange={(e) => onAssign(card.id, e.target.value)}
                className="rounded border border-white/[0.08] bg-transparent px-1 py-0.5 text-[10px]"
                aria-label={`Agent for ${card.title}`}
              >
                <option value="">Unassigned</option>
                {/* An agent can claim a card through the board tool with an id
                    this roster no longer lists; keep it visible either way. */}
                {card.agentId && !agents.some((a) => a.id === card.agentId) && (
                  <option value={card.agentId}>{card.agentId} (not in roster)</option>
                )}
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              {card.sessionId && openableSessionIds.has(card.sessionId) && (
                <button
                  type="button"
                  onClick={() => onOpenSession(card.sessionId as string)}
                  className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                  title="Open the session that created this card"
                  aria-label="Open the session that created this card"
                >
                  <ExternalLink className="size-2.5" /> session
                </button>
              )}
            </div>
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
          <li className="rounded-lg border border-dashed border-white/[0.06] p-3 text-center text-[11px] text-muted-foreground">
            Drop cards here
          </li>
        )}
      </ul>
    </div>
  );
}

export default KanbanSection;
