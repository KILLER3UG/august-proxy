/**
 * QuitConfirmModal — quit gate for window close and tray Quit.
 * Lists working/streaming sessions when any are active.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { LogOut } from 'lucide-react';
import { Backdrop } from '@/components/overlays/Backdrop';
import { isTauri } from '@/lib/tauri-detect';
import { useSessionsStore } from '@/store/sessions';
import { useActiveChatStreamsStore } from '@/store/chat-active-streams';
import type { SessionStatus } from '@/store/sessions/types';
import { cn } from '@/lib/utils';

function isActiveStatus(status: SessionStatus | undefined): boolean {
  return status === 'working' || status === 'streaming';
}

export function QuitConfirmModal() {
  const [open, setOpen] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const sessions = useSessionsStore((s) => s.sessions);
  const sessionStates = useSessionsStore((s) => s.sessionStates);
  const activeChatSessions = useActiveChatStreamsStore((s) => s.active);

  const activeSessions = useMemo(() => {
    const merged: Record<string, SessionStatus> = { ...sessionStates };
    for (const [id, status] of Object.entries(activeChatSessions)) {
      if (!merged[id]) merged[id] = status;
    }
    return sessions.filter((s) => isActiveStatus(merged[s.id]));
  }, [sessions, sessionStates, activeChatSessions]);

  const hasActive = activeSessions.length > 0;

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void listen('quit-requested', () => {
      setOpen(true);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const onCancel = useCallback(() => {
    if (quitting) return;
    setOpen(false);
  }, [quitting]);

  const onQuitAnyway = useCallback(async () => {
    if (quitting) return;
    setQuitting(true);
    try {
      await invoke('confirm_quit');
    } catch {
      setQuitting(false);
    }
  }, [quitting]);

  if (!open) return null;

  return (
    <Backdrop onClose={onCancel} className="z-[70]">
      <div
        className={cn(
          'w-[min(92vw,400px)] rounded-2xl border border-border bg-card shadow-2xl',
          'px-5 pt-5 pb-4',
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quit-confirm-title"
        data-testid="quit-confirm-modal"
      >
        <h2
          id="quit-confirm-title"
          className="text-[15px] font-semibold tracking-tight text-foreground"
        >
          {hasActive ? 'Agent is still working' : 'Quit August?'}
        </h2>
        <p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">
          {hasActive
            ? 'Stopping now will cancel the current task.'
            : 'The app will close and stop the local backend.'}
        </p>

        {hasActive ? (
          <ul className="mt-4 space-y-2" data-testid="quit-active-sessions">
            {activeSessions.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 text-[13px] text-foreground/90"
              >
                <span className="text-muted-foreground/70 select-none" aria-hidden>
                  ::
                </span>
                <span className="truncate">{s.title || 'Untitled session'}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={quitting}
            className={cn(
              'rounded-lg border border-border px-3.5 py-1.5 text-[13px] font-medium',
              'text-foreground/90 hover:bg-accent transition',
            )}
          >
            Cancel
            <span className="ml-1.5 text-muted-foreground/60 text-[11px]">Esc</span>
          </button>
          <button
            type="button"
            onClick={() => { void onQuitAnyway(); }}
            disabled={quitting}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[13px] font-medium',
              'bg-rose-600 text-white hover:bg-rose-500 transition',
              'disabled:opacity-60',
            )}
            data-testid="quit-anyway-btn"
          >
            <LogOut className="size-3.5" aria-hidden />
            {quitting ? 'Quitting…' : 'Quit Anyway'}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}
