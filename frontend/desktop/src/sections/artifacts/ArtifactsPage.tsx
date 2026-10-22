/* ── Artifacts — browse what August made, across every chat ───────────── */
/* The reference's Artifacts page: a grid of things the agent produced,   */
/* grouped by the chat that made them, with a way back to that chat.      */
/*                                                                        */
/* Derivation, not storage: artifacts are collected from each chat's      */
/* messages by the SAME `collectArtifacts` the in-chat drawer uses, over  */
/* the SAME `loadMessagesForSession` the chat itself hydrates from. One   */
/* derivation means the page cannot disagree with the drawer about what   */
/* an artifact is — the failure mode a second implementation guarantees.  */
/*                                                                        */
/* Two reference gestures are deliberately absent: "Shared with you"      */
/* (nothing in August is shared with anyone) and the Docs/Slides/Design   */
/* make-something tiles (they would start artifact types this app does    */
/* not have). A control that promises a surface that does not exist is    */
/* worse than no control.                                                 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpRight,
  FileText,
  Image as ImageIcon,
  Link2,
  Search,
} from 'lucide-react';
import { collectArtifacts, type SessionArtifact } from '@/lib/artifacts';
import { loadMessagesForSession } from '@/sections/chat/chat-stream-manager';
import { useSessionsStore } from '@/store/sessions';
import { SectionHeader } from '@/components/SectionHeader';
import { cn } from '@/lib/utils';

/** How many recent chats the page derives artifacts from. A desktop profile
 *  can carry hundreds; deriving all of them on every keystroke is the kind of
 *  work nobody asked a gallery to do. The cap is stated in the UI, not silent. */
const MAX_CHATS = 40;

type OriginTab = 'all' | 'produced' | 'attached';

const ORIGIN_TABS: Array<{ key: OriginTab; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'produced', label: 'Made by August' },
  { key: 'attached', label: 'Attached' },
];

interface ArtifactRow extends SessionArtifact {
  sessionId: string;
  sessionTitle: string;
}

interface ChatGroup {
  sessionId: string;
  title: string;
  rows: ArtifactRow[];
  lastEdited: string;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `Edited ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function KindIcon({ kind }: { kind: SessionArtifact['kind'] }) {
  if (kind === 'image') return <ImageIcon className="size-4" />;
  if (kind === 'link') return <Link2 className="size-4" />;
  return <FileText className="size-4" />;
}

export function ArtifactsPage() {
  const navigate = useNavigate();
  const sessions = useSessionsStore((s) => s.sessions);
  const [tab, setTab] = useState<OriginTab>('all');
  const [query, setQuery] = useState('');

  const groups = useMemo<ChatGroup[]>(() => {
    const sorted = [...sessions]
      .sort((a, b) => (b.updatedAt ?? b.startedAt).localeCompare(a.updatedAt ?? a.startedAt))
      .slice(0, MAX_CHATS);
    const q = query.trim().toLowerCase();
    const out: ChatGroup[] = [];
    for (const s of sorted) {
      let msgs;
      try {
        msgs = loadMessagesForSession(s.id);
      } catch {
        continue; // a corrupt transcript must not blank the whole gallery
      }
      const rows: ArtifactRow[] = collectArtifacts(msgs)
        .filter((a) => {
          if (tab === 'produced') return a.origin === 'produced';
          if (tab === 'attached') return a.origin === 'uploaded' || a.origin === 'link';
          return true;
        })
        .map((a) => ({ ...a, sessionId: s.id, sessionTitle: s.title || 'Untitled chat' }));
      const hit = rows.filter(
        (r) =>
          !q ||
          r.label.toLowerCase().includes(q) ||
          s.title.toLowerCase().includes(q),
      );
      if (hit.length === 0) continue;
      const newest = hit.reduce((acc, r) => (r.timestamp > acc ? r.timestamp : acc), hit[0].timestamp);
      out.push({ sessionId: s.id, title: s.title || 'Untitled chat', rows: hit, lastEdited: newest });
    }
    return out;
  }, [sessions, tab, query]);

  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const capped = sessions.length > MAX_CHATS;

  const openInChat = (sessionId: string) => {
    void navigate(`/c/${sessionId}`);
    // The drawer derives its list from the now-active session, so opening it
    // after the navigation lands the user on the artifact they clicked.
    window.dispatchEvent(new CustomEvent('august:open-right-sidebar'));
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-8">
      <SectionHeader title="Artifacts" className="mb-5" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Artifact origin"
          className="flex items-center gap-1 rounded-lg border border-border/60 bg-card/40 p-0.5"
        >
          {ORIGIN_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'cursor-pointer rounded-md px-3 py-1.5 text-[0.8125rem] transition-colors',
                tab === t.key
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 rounded-lg border border-border/60 bg-card/40 px-2.5 py-1.5 focus-within:border-primary/40">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search artifacts or chats"
            aria-label="Search artifacts"
            className="w-56 bg-transparent text-[0.8125rem] text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      </div>

      <p className="mt-3 text-2xs text-muted-foreground/70" data-testid="artifacts-count">
        {total} artifact{total === 1 ? '' : 's'} across {groups.length} chat
        {groups.length === 1 ? '' : 's'}
        {capped ? ` · derived from your ${MAX_CHATS} most recent chats` : ''}
      </p>

      {groups.length === 0 ? (
        <div className="mt-16 text-center text-sm text-muted-foreground/70">
          Nothing here yet. Ask August to make a file, and it lands on this page.
        </div>
      ) : (
        <div className="mt-6 space-y-8">
          {groups.map((g) => (
            <section key={g.sessionId} aria-label={g.title}>
              <div className="mb-2.5 flex items-baseline justify-between gap-3">
                <h2 className="min-w-0 truncate text-[0.8125rem] font-medium text-muted-foreground">
                  {g.title}
                </h2>
                <button
                  type="button"
                  onClick={() => openInChat(g.sessionId)}
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground/80 transition-colors hover:bg-muted/40 hover:text-foreground"
                  title="Open the chat that made these"
                >
                  Open chat <ArrowUpRight className="size-3" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {g.rows.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => openInChat(r.sessionId)}
                    className="group cursor-pointer overflow-hidden rounded-xl border border-border/60 bg-card/50 text-left transition-colors hover:border-border hover:bg-card"
                    title={`Made in "${r.sessionTitle}" — click to open that chat`}
                  >
                    <div className="flex h-24 items-center justify-center overflow-hidden border-b border-border/40 bg-muted/20">
                      {r.thumbnailUrl ? (
                        <img
                          src={r.thumbnailUrl}
                          alt=""
                          className="max-h-full max-w-full object-contain"
                          loading="lazy"
                        />
                      ) : (
                        <KindIcon kind={r.kind} />
                      )}
                    </div>
                    <div className="p-3">
                      <p className="truncate text-[0.8125rem] font-medium text-foreground">
                        {r.label}
                      </p>
                      <p className="mt-0.5 truncate text-2xs text-muted-foreground/70">
                        {r.snippet || r.meta || r.kind}
                      </p>
                      <p className="mt-1.5 text-2xs text-muted-foreground/60">
                        {formatWhen(r.timestamp)}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
