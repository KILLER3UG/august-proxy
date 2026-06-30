/* v4.4.1 — BrainIndicator: titlebar Brain icon + pulse dot + floating popup.
   Replaces the v4.4.0 modal (which covered the chat area) with a
   non-blocking popup anchored under the icon. Subscribes to the brain
   event stream so it can light up a pulse + bump an unseen count whenever
   a new brain event fires while the popup is closed. */
import { useEffect, useState } from 'react';
import { Brain, X, Activity, Heart, Sparkles } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import {
  getBrainEvents,
  openBrainEventStream,
  type BrainEvent,
} from '@/api/api-client';
import { LearningTab } from '@/sections/brain/LearningTab';
import { SystemHealthTab } from '@/sections/brain/SystemHealthTab';
import { BrainActivityTab } from '@/sections/brain/BrainActivityTab';

interface BrainIndicatorProps {
  /** Optional initial unseen-event count (for tests + future bootstrap). */
  initialUnseen?: number;
}

type TabKey = 'activity' | 'learning' | 'health';

const POPUP_WIDTH = 520;
const POPUP_MAX_HEIGHT = 520;

export function BrainIndicator({ initialUnseen = 0 }: BrainIndicatorProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>('activity');
  const [unseen, setUnseen] = useState(initialUnseen);
  const [, setTickVersion] = useState(0); // forces EventSource effect re-run

  // Pre-fetch recent events so the popup has content instantly
  useQuery({
    queryKey: ['brain-events'],
    queryFn: () => getBrainEvents(200),
    enabled: open,
  });

  // Always-on SSE so we can bump the unseen counter even when popup is closed
  useEffect(() => {
    const es = openBrainEventStream();
    es.onmessage = (ev: MessageEvent) => {
      try {
        const event: BrainEvent = JSON.parse(ev.data);
        setUnseen((n) => n + 1);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => es.close();
  }, []);

  // Esc closes the popup
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Click-outside closes the popup
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Don't close if click is inside the popup or on the toggle button
      if (target.closest('[data-brain-popup-root]')) return;
      if (target.closest('[data-brain-toggle]')) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [open]);

  const handleOpen = () => {
    setOpen((v) => !v);
    // Reset unseen when opening
    if (!open) setUnseen(0);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        aria-label="Toggle Brain activity"
        aria-expanded={open}
        data-testid="titlebar-brain-button"
        data-brain-toggle
        className={cn(
          'relative p-1 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition',
          open && 'bg-accent text-foreground',
        )}
        title="Brain activity"
      >
        <Brain className="size-4" />
        {/* Pulse dot for unseen events */}
        {unseen > 0 && (
          <span
            data-testid="brain-pulse-dot"
            className="absolute top-0.5 right-0.5 size-2 rounded-full bg-primary ring-2 ring-background animate-pulse"
            aria-label={`${unseen} unseen brain event(s)`}
          />
        )}
      </button>

      {open && (
        <div
          data-testid="brain-popup"
          data-brain-popup-root
          role="dialog"
          aria-label="Brain activity"
          className="fixed top-12 right-2 z-50 bg-popover border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
          style={{ width: POPUP_WIDTH, maxHeight: POPUP_MAX_HEIGHT }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
            <div className="flex items-center gap-2">
              <Brain className="size-4 text-primary" />
              <span className="text-sm font-semibold">Brain</span>
              <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                realtime flow
              </span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 px-2 pt-1.5 border-b border-border shrink-0">
            {(
              [
                { key: 'activity' as const, label: 'Activity', icon: Activity },
                { key: 'learning' as const, label: 'Learning', icon: Sparkles },
                { key: 'health'   as const, label: 'Health',   icon: Heart },
              ]
            ).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cn(
                  'flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-t-md border-b-2 transition',
                  tab === key
                    ? 'border-primary text-foreground bg-popover'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50',
                )}
                data-testid={`brain-popup-tab-${key}`}
              >
                <Icon className="size-3" />
                {label}
              </button>
            ))}
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-2">
            {tab === 'activity' && <BrainActivityTab />}
            {tab === 'learning' && <LearningTab />}
            {tab === 'health' && <SystemHealthTab />}
          </div>
        </div>
      )}
    </>
  );
}
