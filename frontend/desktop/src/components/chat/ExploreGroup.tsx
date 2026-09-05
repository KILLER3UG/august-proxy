/* ── ExploreGroup — Part 27 B1: one row per consecutive read-only run ──── */
/* Searches + file reads collapse under a single "Explore · N searches, M
   files" parent; children nest indented and stay individually expandable.
   Open while any child runs; auto-collapses once the run settles (the next
   non-read step lands). Edits, memory writes, commands, and subagent rows
   never join a group. */

import { useState, type ReactNode } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ExploreGroupProps {
  searches: number;
  files: number;
  running: boolean;
  /** Stable key for the manual expand override. */
  groupKey: string;
  /** Parent-controlled override (AssistantBlockTimeline expandOverrides). */
  expanded?: boolean;
  onToggle?: (next: boolean) => void;
  children: ReactNode;
}

export function ExploreGroup({
  searches,
  files,
  running,
  groupKey,
  expanded,
  onToggle,
  children,
}: ExploreGroupProps) {
  const [localOpen, setLocalOpen] = useState(false);
  // Parent controls open (running → open, settle → collapse); when it does
  // not pass an explicit value, default to open while running.
  const open = expanded ?? (running || localOpen);
  const toggle = (next: boolean) => {
    setLocalOpen(next);
    onToggle?.(next);
  };

  const parts: string[] = [];
  if (searches > 0) parts.push(`${searches} search${searches === 1 ? '' : 'es'}`);
  if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'}`);
  const label = parts.length > 0 ? `Explore · ${parts.join(', ')}` : 'Explore';

  return (
    <div className="row-enter my-0.5" data-slot="explore-group" data-group-key={groupKey}>
      <button
        type="button"
        onClick={() => toggle(!open)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[13px] leading-5 text-foreground/80 transition-colors hover:bg-white/[0.03]"
        data-testid="explore-group-head"
      >
        <Search className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
        <span className="shrink-0 font-medium">{label}</span>
        {running && (
          <span className="shrink-0 text-[10px] italic text-muted-foreground/70">working…</span>
        )}
        <ChevronDown
          className={cn(
            'ml-auto size-3 shrink-0 text-muted-foreground/60 transition-transform',
            !open && '-rotate-90',
          )}
          aria-hidden
        />
      </button>
      {open && (
        <div className="ml-2 space-y-0.5 border-l border-white/[0.06] pl-2 pt-0.5">
          {children}
        </div>
      )}
    </div>
  );
}
