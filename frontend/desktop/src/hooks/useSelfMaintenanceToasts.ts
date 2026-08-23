/* ── useSelfMaintenanceToasts ──────────────────────────────────────────── */
/* 0.16.8: user asked for visible feedback when memory or skills change.
 * Listens to the existing brain SSE stream and raises quiet toasts for
 * memory-review applications, skill genesis/evolution, and boot-maintenance
 * completion. Deduplicates by event id so SSE reconnects never re-toast.
 * (The inline SelfImprovementStrip in-chat line stays; this covers the
 * whole app, including Settings.) */

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { openBrainEventStream, type BrainEvent } from '@/api/api-client';

const DISMISSED_KEY = 'august-maintenance-toast-dismissed';
const MAX_DISMISSED = 200;

function loadDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]') as string[]);
  } catch {
    return new Set();
  }
}

function rememberDismissed(id: string, set: Set<string>) {
  set.add(id);
  if (set.size > MAX_DISMISSED) {
    const it = set.values().next();
    if (!it.done) set.delete(it.value);
  }
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

export function useSelfMaintenanceToasts(enabled = true) {
  const dismissedRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    dismissedRef.current = dismissedRef.current ?? loadDismissed();

    const es = openBrainEventStream();
    es.onmessage = (ev: MessageEvent) => {
      let e: BrainEvent;
      try {
        e = JSON.parse(ev.data) as BrainEvent;
      } catch {
        return;
      }
      // Boot start is shown by SelfMaintenanceLine's spinner — skip it here.
      const phase = (e.meta?.phase as string) || '';
      if (e.layer === 'auto_maintenance.boot' && phase === 'start') return;

      const id = String((e.meta?.id as string) ?? `${e.category}:${e.summary}:${Math.round(Date.now() / 1000)}`);
      const dismissed = dismissedRef.current!;
      if (dismissed.has(id)) return;
      rememberDismissed(id, dismissed);

      switch (e.category) {
        case 'skill_genesis':
          toast.success(e.summary, { id, description: 'Skills updated automatically' });
          break;
        case 'self_improvement':
          toast.message(e.summary, {
            id,
            description:
              e.meta?.type === 'bootMaintenance'
                ? 'Fresh-start maintenance complete'
                : 'Memory updated automatically',
          });
          break;
        default:
          break;
      }
    };
    return () => es.close();
  }, [enabled]);
}
