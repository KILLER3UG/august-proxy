/* ── HistoryPage ── browse past conversations, grouped by day ─────────── */
/* Sessions are searchable by title / last message / model; clicking a row
 * opens the session. Data comes from the local sessions store (the same
 * source the sidebar uses), so it works offline and matches the sidebar. */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, MessageSquare, Plus, Trash2, History } from 'lucide-react';
import { deleteSession, useSessionsStore, type Session } from '@/store/sessions';

function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export function HistoryPage() {
  const sessions = useSessionsStore((s) => s.sessions);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

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
    const map = new Map<string, Session[]>();
    for (const s of sorted) {
      const key = dayKey(s.startedAt);
      const bucket = map.get(key);
      if (bucket) bucket.push(s);
      else map.set(key, [s]);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden p-6 max-w-3xl mx-auto space-y-5" data-testid="history-page">
      <div className="flex items-center gap-3">
        <History className="size-5 text-primary" />
        <h1 className="text-base font-semibold">Conversation history</h1>
        <button
          type="button"
          onClick={() => void navigate('/')}
          className="ml-auto inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground"
          data-testid="history-new-chat"
        >
          <Plus className="size-3" />
          New chat
        </button>
      </div>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title, message, or model…"
          className="w-full rounded-lg border border-border/60 bg-card/60 py-2 pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary/40"
          data-testid="history-search"
        />
      </div>
      {sessions.length === 0 ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center text-xs text-muted-foreground">
          No conversations yet — start one and it will appear here.
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center text-xs text-muted-foreground">
          No conversations match “{query}”.
        </div>
      ) : (
        groups.map(([day, items]) => (
          <section key={day}>
            <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              {day} · {items.length}
            </h2>
            <ul className="space-y-1">
              {items.map((s) => (
                <li key={s.id}>
                  <div className="group flex items-center gap-3 rounded-lg border border-border/50 bg-card/50 px-3 py-2 transition hover:border-primary/30 hover:bg-card">
                    <button
                      type="button"
                      onClick={() => void navigate(`/c/${s.id}`)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      data-testid={`history-session-${s.id}`}
                    >
                      <MessageSquare className="size-3.5 shrink-0 text-muted-foreground/70" />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-foreground">
                          {s.title || 'Untitled chat'}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground/80">
                          {s.lastMessage || 'No messages yet'}
                        </span>
                      </span>
                      <span className="ml-auto shrink-0 text-right text-[10px] text-muted-foreground/60">
                        <span className="block">{s.model || s.provider || '—'}</span>
                        <span className="block">{s.messageCount ?? 0} msgs</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      title="Delete conversation"
                      className="p-1 rounded text-muted-foreground/50 opacity-0 group-hover:opacity-100 hover:text-danger transition"
                      onClick={() => deleteSession(s.id)}
                      data-testid={`history-delete-${s.id}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
