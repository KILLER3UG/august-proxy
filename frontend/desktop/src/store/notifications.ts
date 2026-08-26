/**
 * Notifications center (C1) — a small bell fed by notable events from the
 * chat stream (turn failures, arena lane completions).
 * Replaces scattered toasts for events you may want to revisit.
 */
import { create } from 'zustand';

export interface AppNotification {
  id: string;
  title: string;
  body?: string;
  kind?: 'error' | 'arena' | 'routing' | 'info';
  at: number;
  seen: boolean;
}

interface NotificationsState {
  items: AppNotification[];
}

const MAX_NOTIFICATIONS = 50;

export const useNotificationsStore = create<NotificationsState>(() => ({
  items: [],
}));

export function pushNotification(
  title: string,
  body?: string,
  kind: AppNotification['kind'] = 'info',
): void {
  const items = useNotificationsStore.getState().items;
  const next: AppNotification = {
    id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title,
    body,
    kind,
    at: Date.now(),
    seen: false,
  };
  useNotificationsStore.setState({ items: [next, ...items].slice(0, MAX_NOTIFICATIONS) });
}

export function markAllNotificationsRead(): void {
  const items = useNotificationsStore.getState().items;
  if (items.every((n) => n.seen)) return;
  useNotificationsStore.setState({
    items: items.map((n) => (n.seen ? n : { ...n, seen: true })),
  });
}

export function clearNotifications(): void {
  useNotificationsStore.setState({ items: [] });
}
