/* ── ContextUsedBadge ─────────────────────────────────────────────────── */
/* "What August used this turn" — a small brain chip beside the context
 * ring. Hover/click reveals what memory & context the harness injected into
 * the last turn's prompt (profile, heuristics, added/recalled memories,
 * current context, AUG directives). Fed by the backend `done` event payload
 * (A5); falls back to GET /api/workbench/sessions/{id}/context for sessions
 * opened after the fact. */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { Brain, X } from 'lucide-react';
import { api } from '@/api/client';
import {
  $sessionContextUsed,
  setSessionContextUsed,
  type ContextSnapshot,
} from '../context-used-store';

function snapshotCount(snap: ContextSnapshot): number {
  let n = 0;
  if (snap.profileSummaryUsed) n += 1;
  n += snap.heuristicsUsed ?? 0;
  n += snap.addedMemories ?? 0;
  n += snap.recalledMemories?.length ?? 0;
  if (snap.currentContextUsed) n += 1;
  n += snap.activeProjects ?? 0;
  if (snap.coreFactsUsed) n += 1;
  if (snap.augDirectiveUsed) n += 1;
  return n;
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <li className="flex items-baseline justify-between gap-3 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium ${tone ?? ''}`}>{value}</span>
    </li>
  );
}

export function ContextUsedBadge({ sessionId }: { sessionId: string | null }) {
  const bySession = useSyncExternalStore(
    $sessionContextUsed.subscribe,
    $sessionContextUsed.get,
  );
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  const snapshot = sessionId ? bySession[sessionId] : undefined;

  // Fallback for sessions without a live done-event snapshot (reopened
  // sessions, or turns before the feature shipped).
  useEffect(() => {
    if (!sessionId || snapshot !== undefined) return;
    let cancelled = false;
    api
      .get<{ context: ContextSnapshot | null }>(
        `/api/workbench/sessions/${encodeURIComponent(sessionId)}/context`,
      )
      .then((res) => {
        if (!cancelled) setSessionContextUsed(sessionId, res.context ?? null);
      })
      .catch(() => {
        if (!cancelled) setSessionContextUsed(sessionId, null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, snapshot]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  if (snapshot === undefined) return null; // still loading / no data yet
  if (snapshot === null) return null; // backend has no snapshot (pre-feature)

  const count = snapshotCount(snapshot);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="What August used this turn"
        title={
          count > 0
            ? `What August used: ${count} memory/context item(s) in the last turn`
            : 'What August used this turn'
        }
        className="inline-flex items-center gap-1 rounded-full bg-muted/70 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground transition"
        data-testid="context-used-badge"
      >
        <Brain className="size-3" />
        {count > 0 ? count : '—'}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Context used this turn"
          className="absolute bottom-full right-0 mb-1.5 w-64 rounded-lg border border-border bg-popover p-3 shadow-lg z-50"
          data-testid="context-used-panel"
        >
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              What August used
            </h4>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <X className="size-3" />
            </button>
          </div>
          {count === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              This turn used no recalled memory or learned context — the model answered from the
              conversation alone.
            </p>
          ) : (
            <ul className="space-y-1.5">
              <Row label="Profile summary" value={snapshot.profileSummaryUsed ? 'yes' : 'no'} tone={snapshot.profileSummaryUsed ? 'text-primary' : undefined} />
              <Row label="Learned rules" value={String(snapshot.heuristicsUsed ?? 0)} />
              <Row label="Added memories" value={String(snapshot.addedMemories ?? 0)} />
              <Row
                label="Recalled memories"
                value={String(snapshot.recalledMemories?.length ?? 0)}
              />
              <Row label="Current context" value={snapshot.currentContextUsed ? 'yes' : 'no'} tone={snapshot.currentContextUsed ? 'text-primary' : undefined} />
              <Row label="Active projects" value={String(snapshot.activeProjects ?? 0)} />
              <Row label="Core facts" value={snapshot.coreFactsUsed ? 'yes' : 'no'} tone={snapshot.coreFactsUsed ? 'text-primary' : undefined} />
              <Row label="AUG directives" value={snapshot.augDirectiveUsed ? 'yes' : 'no'} tone={snapshot.augDirectiveUsed ? 'text-primary' : undefined} />
            </ul>
          )}
          {(snapshot.recalledMemories?.length ?? 0) > 0 ? (
            <div className="mt-2 space-y-1 border-t border-border pt-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Recalled from your history
              </p>
              {snapshot.recalledMemories!.slice(0, 3).map((m) => (
                <p key={m.key ?? m.snippet} className="text-[11px] text-muted-foreground line-clamp-2">
                  <span className="text-foreground/80 font-medium">{m.key ?? m.category}</span>
                  {m.snippet ? ` — ${m.snippet}` : ''}
                </p>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => navigate('/brain?tab=you')}
            className="mt-2 w-full text-[11px] text-primary hover:underline"
            data-testid="context-used-open-profile"
          >
            View full profile — edit or delete what August knows →
          </button>
        </div>
      ) : null}
    </div>
  );
}
