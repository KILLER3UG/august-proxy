/**
 * SearchResultsCard — web-search results as a specialized Task block.
 *
 * Same collapsible pattern as the per-tool Task rows: trigger shows the
 * search query with a right-aligned result count; content is a scroll-capped
 * list of hits with real site favicons (Globe fallback), bold truncated
 * titles, and muted right-aligned domains.
 *
 * `SearchResultsList` is the bare list — the legacy ToolCallItemBody path
 * mounts it directly (no second-level disclosure inside an already-expanded
 * tool body); `SearchResultsTask` is the full Task block used by the
 * chat timeline's tool-execution panel.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Globe, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Task,
  TaskContent,
  TaskTrigger,
} from '@/components/ui/task';

export type SearchHit = { title: string; url: string; snippet?: string };

function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** Real site favicon (Google s2), falling back to a globe icon on error. */
function SiteFavicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const host = useMemo(() => hostFromUrl(url), [url]);
  if (failed || !host) {
    return <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${host}&sz=32`}
      alt=""
      className="size-4 shrink-0 rounded"
      width={16}
      height={16}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** Scroll-capped results list — one row per hit: favicon · title · domain. */
export function SearchResultsList({ hits }: { hits: SearchHit[] }) {
  return (
    <div
      className={cn(
        'tool-result-scroll max-h-52 min-w-0 overflow-y-auto overscroll-contain',
        'rounded-lg border border-border bg-popover px-2.5 py-2',
      )}
      onWheel={(e) => {
        if (e.currentTarget.scrollHeight > e.currentTarget.clientHeight) e.stopPropagation();
      }}
    >
      <ol className="m-0 grid list-none gap-1.5 p-0">
        {hits.map((hit, i) => {
          const host = hit.url ? hostFromUrl(hit.url) : null;
          return (
            <li key={`${hit.url || hit.title}-${i}`} className="flex min-w-0 items-center gap-2">
              {hit.url ? <SiteFavicon url={hit.url} /> : null}
              {hit.url ? (
                <a
                  href={hit.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-sm font-medium text-primary hover:underline"
                  title={hit.title || hit.url}
                >
                  {hit.title || host || hit.url}
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {hit.title}
                </span>
              )}
              {host ? (
                <span className="shrink-0 text-xs text-muted-foreground">{host}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function SearchResultsTask({
  query,
  hits,
  expanded,
  onToggle,
  className,
}: {
  /** The search query — trigger title (regular weight). */
  query: string;
  hits: SearchHit[];
  /** Parent-derived open hint; re-opens while running, never force-collapses. */
  expanded: boolean;
  onToggle: (next: boolean) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(expanded);
  useEffect(() => {
    if (expanded) setOpen(true);
  }, [expanded]);

  const count = hits.length;

  return (
    <div data-slot="search-results-task" className={className}>
      <Task
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onToggle(next);
        }}
      >
        <TaskTrigger title={query}>
          <button
            type="button"
            className="flex min-h-[24px] w-full items-center gap-2 rounded-xs px-1 py-0.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <span className="process-step-gutter" aria-hidden>
              <Search className="process-step-icon" />
            </span>
            <span className="process-tool-label flex-1" title={query}>
              {query}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {count} result{count === 1 ? '' : 's'}
            </span>
            <ChevronDown
              className="process-tool-chevron group-data-[state=open]:rotate-180"
              aria-hidden
            />
          </button>
        </TaskTrigger>
        <TaskContent className="mb-1 ml-[26px]">
          <SearchResultsList hits={hits} />
        </TaskContent>
      </Task>
    </div>
  );
}
