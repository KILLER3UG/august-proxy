/* ── Durable multi-agent kanban board ─────────────────────────────────── */
/* Mounted twice: as the /board work surface, and as the Settings →
 * "Agent board" section. The board page owns its own page header, so the
 * header here is optional (`showHeader={false}`) — one surface, one title.
 *
 * Density note: a card used to carry five controls, three of them always-on
 * "→ Column" buttons that duplicated the drag-and-drop already wired. They
 * are now ONE menu (drag stays the primary interaction, the menu keeps the
 * keyboard route), the card's X is revealed on hover, and the empty-column
 * placeholder is a borderless hint rather than a dashed box. */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, Kanban, MoreHorizontal, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { QueryErrorState } from '@/components/QueryErrorState';
import { cn } from '@/lib/utils';
import { listBots } from '@/api/api-client';
import { useSessionsStore } from '@/store/sessions';
import {
  useKanbanStore,
  KANBAN_COLUMNS,
  type KanbanCard,
  type KanbanColumnId,
} from '@/store/kanban-board';

export function KanbanSection({ showHeader = true }: { showHeader?: boolean }) {
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
  const { data: botsData, isError: botsFailed, error: botsError, refetch: refetchBots } = useQuery({
    queryKey: ['bots'],
    queryFn: () => listBots(),
  });
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
    <div className={cn('px-8 py-6 space-y-4 h-full flex flex-col', !showHeader && 'px-0 py-0')} data-testid="kanban-section">
      {showHeader && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Kanban className="size-5 text-primary" />
              Agent board
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Durable kanban across agents and jobs
            </p>
          </div>
          {/* flex-wrap: the two fixed-width inputs + two buttons need ~700px.
              In a ~660px column (900px window) the row overflowed its
              overflow-hidden ancestor and "Clear done" kept only a 27px sliver
              visible — the dead-button-at-900px report. Inputs shrink first
              (min-w-0), the buttons wrap whole. */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onAdd();
              }}
              placeholder="New card title…"
              className="w-56 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-xs sm:flex-none"
            />
            <input
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onAdd();
              }}
              placeholder="Detail for whoever picks it up (optional)"
              aria-label="New card detail"
              className="w-72 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-xs sm:flex-none"
            />
            <Button size="sm" onClick={onAdd}>
              <Plus className="size-3" /> Add
            </Button>
            <Button size="sm" variant="outline" onClick={clearDone}>
              <Trash2 className="size-3" /> Clear done
            </Button>
          </div>
        </div>
      )}

      {/* The roster query only fills the per-card "agent" picker; the board
          itself comes from local storage. A failure is still worth saying —
          an empty picker reads as "no agents exist" otherwise. */}
      {botsFailed && (
        <QueryErrorState
          compact
          error={botsError}
          onRetry={() => void refetchBots()}
          title="Couldn't load the agent roster"
          note="Cards can still be moved and assigned by hand."
        />
      )}

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
        'flex min-h-[12rem] flex-col rounded-xl border border-border/60 bg-card/40',
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
      {/* Section labels are muted and small, in sentence case — the reference's
          own section headers, not the admin-panel uppercase. */}
      <div className="border-b border-border/60 px-3 py-2 text-2xs text-muted-foreground">
        {label} · {cards.length}
      </div>
      <ul className="flex-1 space-y-2 p-2 overflow-auto">
        {cards.map((card) => (
          <li
            key={card.id}
            className="group rounded-lg border border-border/60 bg-card p-2 text-xs"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/kanban-id', card.id);
            }}
          >
            <div className="flex items-start justify-between gap-1">
              <span className="font-medium text-foreground/90">{card.title}</span>
              <div className="flex shrink-0 items-center gap-0.5">
                {/* ONE move control, revealed on hover: the three always-on
                    "→ Column" buttons duplicated the drag-and-drop. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title="Move card"
                      aria-label="Move card"
                      className="size-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                    >
                      <MoreHorizontal className="size-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {KANBAN_COLUMNS.filter((c) => c.id !== id).map((c) => (
                      <DropdownMenuItem
                        key={c.id}
                        onSelect={() => onMove(card.id, c.id)}
                        className="text-xs"
                      >
                        Move to {c.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => onRemove(card.id)}
                  aria-label="Remove card"
                  title="Remove card"
                  className="size-6 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X className="size-3" />
                </Button>
              </div>
            </div>
            {card.body && (
              <div className="mt-1 whitespace-pre-wrap text-2xs text-muted-foreground">
                {card.body}
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <select
                value={card.agentId ?? ''}
                onChange={(e) => onAssign(card.id, e.target.value)}
                className="rounded border border-border/60 bg-transparent px-1 py-0.5 text-2xs"
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
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onOpenSession(card.sessionId as string)}
                  title="Open the session that created this card"
                  aria-label="Open the session that created this card"
                  className="h-5 px-1 text-2xs text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="size-2.5" /> session
                </Button>
              )}
            </div>
          </li>
        ))}
        {cards.length === 0 && (
          /* One borderless hint, not a dashed placeholder box: the reference
             uses spacing, not containers, for empty space. */
          <li className="px-1 py-2 text-center text-2xs text-muted-foreground/70">
            Drop cards here
          </li>
        )}
      </ul>
    </div>
  );
}

export default KanbanSection;
