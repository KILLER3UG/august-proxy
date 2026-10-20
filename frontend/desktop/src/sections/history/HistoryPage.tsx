/* ── HistoryPage ── browse past conversations, grouped by day ─────────── */
/* Sessions are searchable by title / last message / model; clicking a row
 * opens the session. Data comes from the local sessions store (the same
 * source the sidebar uses), so it works offline and matches the sidebar.
 *
 * Density note: this list used to be a stack of bordered cards, each with a
 * per-row icon, a permanently visible delete button and an uppercase group
 * heading. The reference's own list views are borderless rows separated by a
 * hairline, a bold sentence-case section header, a muted summary column, and
 * a delete affordance that appears at the far right on hover — so that is
 * what this is now. */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { History, Plus, Search, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/overlays/ConfirmDialog';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { Button } from '@/components/ui/button';
import { deleteSession, useSessionsStore, type Session } from '@/store/sessions';
import { groupByDate } from '@/lib/date-group';

export function HistoryPage() {
  const sessions = useSessionsStore((s) => s.sessions);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const { state: confirmState, confirm: confirmStyled, handleConfirm, handleCancel } =
    useConfirmDialog();

  // Deletion here is unrecoverable — the session and its transcript are gone
  // from the local store with no trash. It used to fire on a single click of
  // the trash icon, one row below the click that opens a chat.
  async function requestDelete(session: Session) {
    const ok = await confirmStyled({
      title: 'Delete this conversation?',
      // "and its N message(s)" used to be the whole promise while the delete also
      // dropped whatever the composer still held unsent — the one thing in the
      // row that is not a message.
      message: `"${session.title || 'Untitled chat'}", its ${session.messageCount ?? 0} message(s) and anything still unsent in its composer will be removed. This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (ok) deleteSession(session.id);
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = sessions.filter((s) => !s.isArchived);
    if (!q) return list;
    return list.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.lastMessage || '').toLowerCase().includes(q) ||
        (s.model || '').toLowerCase().includes(q) ||
        (s.provider || '').toLowerCase().includes(q),
    );
  }, [sessions, query]);

  const groups = useMemo(() => {
    const sorted = [...filtered].sort((a, b) =>
      String(b.startedAt || '').localeCompare(String(a.startedAt || '')),
    );
    return groupByDate(sorted, (s) => s.startedAt);
  }, [filtered]);

  const searching = query.trim().length > 0;

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden p-6 max-w-3xl mx-auto space-y-4" data-testid="history-page">
      <div className="flex items-center gap-3">
        <History className="size-5 text-muted-foreground" />
        {/* h2, not h1: the titlebar already renders this route's single h1. */}
        <h2 className="text-base font-semibold">Conversation history</h2>
        <Button
          className="ml-auto"
          size="sm"
          onClick={() => void navigate('/')}
          data-testid="history-new-chat"
        >
          <Plus className="size-3" />
          New chat
        </Button>
      </div>
      {/* Search is a pill-shaped input with a border — the reference's own
          search affordance, not a bare magnifier that hides one on click. */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title, message, or model…"
          className="w-full rounded-full border border-border/60 bg-card/60 py-2 pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/40"
          data-testid="history-search"
        />
      </div>
      {sessions.length === 0 ? (
        <p className="p-8 text-center text-xs text-muted-foreground">
          No conversations yet — start one and it will appear here.
        </p>
      ) : filtered.length === 0 ? (
        <p className="p-8 text-center text-xs text-muted-foreground">
          No conversations match “{query}”.
        </p>
      ) : (
        groups.map((g) => (
          /* Today and Yesterday start open; older days are collapsed. A
             search opens every group, because a collapsed group would hide
             the very rows the search found. */
          <details
            key={g.label}
            open={searching || g.label === 'Today' || g.label === 'Yesterday'}
            className="group/day"
          >
            <summary
              className="flex cursor-pointer list-none items-center gap-2 border-b border-border/60 pb-1.5 [&::-webkit-details-marker]:hidden"
              data-testid={`history-group-${g.label}`}
            >
              <span className="text-sm font-semibold text-foreground">{g.label}</span>
            </summary>
            <ul className="mt-1 divide-y divide-border/60">
              {g.items.map((s) => (
                <li
                  key={s.id}
                  className="group relative flex items-center gap-3 px-2 py-2 transition-colors hover:bg-muted/40"
                >
                  <button
                    type="button"
                    onClick={() => void navigate(`/c/${s.id}`)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    data-testid={`history-session-${s.id}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {s.title || 'Untitled chat'}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground/80">
                        {s.lastMessage || 'No messages yet'}
                      </span>
                    </span>
                    {/* Muted, right-aligned metadata column. The delete button
                        takes its place on hover, the way the reference's rows
                        do — the reserved slot keeps the row from shifting. */}
                    <span className="mr-8 shrink-0 text-right text-2xs text-muted-foreground/70 transition-opacity group-hover:opacity-0">
                      <span className="block">{s.model || s.provider || '—'}</span>
                      <span className="block tabular-nums">
                        {`${s.messageCount ?? 0} ${s.messageCount === 1 ? 'msg' : 'msgs'}`}
                      </span>
                    </span>
                  </button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${s.title || 'Untitled chat'} conversation`}
                    title="Delete conversation"
                    className="absolute right-1 text-muted-foreground opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => void requestDelete(s)}
                    data-testid={`history-delete-${s.id}`}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        ))
      )}
      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        cancelLabel={confirmState.cancelLabel}
        variant={confirmState.variant}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </div>
  );
}
