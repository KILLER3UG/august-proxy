/* ── NotificationBell — unread badge + dropdown panel (C1) ────────────── */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bell, CheckCheck, ShieldAlert, Swords, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useNotificationsStore,
  markAllNotificationsRead,
  clearNotifications,
  type AppNotification,
} from '@/store/notifications';

const KIND_ICONS: Record<NonNullable<AppNotification['kind']>, typeof Bell> = {
  error: AlertTriangle,
  verifier: ShieldAlert,
  arena: Swords,
  info: Bell,
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function NotificationBell() {
  const items = useNotificationsStore((s) => s.items);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const unread = items.filter((n) => !n.seen).length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          if (!open && unread > 0) markAllNotificationsRead();
        }}
        className="relative p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition"
        title="Notifications"
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
        aria-expanded={open}
        data-testid="notification-bell"
      >
        <Bell className="size-4" />
        {unread > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-0.5 rounded-full bg-primary text-primary-foreground text-[9px] font-semibold flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className="absolute right-0 top-full mt-1.5 w-80 max-h-96 overflow-y-auto rounded-lg border border-border bg-popover p-2 shadow-lg z-50"
          data-testid="notification-panel"
        >
          <div className="flex items-center justify-between px-1.5 py-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Notifications
            </span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={markAllNotificationsRead}
                disabled={unread === 0}
                className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-40"
                title="Mark all read"
              >
                <CheckCheck className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={clearNotifications}
                disabled={items.length === 0}
                className="p-1 rounded text-muted-foreground hover:text-danger disabled:opacity-40"
                title="Clear all"
              >
                <Trash2 className="size-3.5" />
              </button>
            </span>
          </div>
          {items.length === 0 ? (
            <p className="px-1.5 py-4 text-center text-[11px] text-muted-foreground">
              No notifications yet — failures, verifier gates, and arena lanes land here.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {items.map((n) => {
                const Icon = KIND_ICONS[n.kind ?? 'info'];
                return (
                  <li
                    key={n.id}
                    className={cn(
                      'flex items-start gap-2 rounded-md px-2 py-1.5 text-[11px]',
                      n.seen ? 'opacity-60' : 'bg-muted/40',
                    )}
                  >
                    <Icon
                      className={cn(
                        'size-3.5 shrink-0 mt-0.5',
                        n.kind === 'error' && 'text-rose-400',
                        n.kind === 'verifier' && 'text-amber-400',
                        n.kind === 'arena' && 'text-primary',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{n.title}</p>
                      {n.body ? (
                        <p className="text-muted-foreground line-clamp-2 break-words">{n.body}</p>
                      ) : null}
                    </div>
                    <span className="text-[9px] text-muted-foreground shrink-0 mt-0.5">
                      {formatTime(n.at)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
