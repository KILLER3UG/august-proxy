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
import { ChevronDown, ChevronRight, Globe, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { safeExternalHref } from '@/lib/safe-href';
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

/** Scroll-capped results list — one row per hit: favicon · title · domain.
 *  Claude-parity: shows the first N hits inline with a "Show N more results"
 *  expander instead of an inner scrollbar (no nested scroll inside chat). */
const INLINE_HITS = 4;

export function SearchResultsList({ hits }: { hits: SearchHit[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? hits : hits.slice(0, INLINE_HITS);
  const hidden = hits.length - visible.length;
  return (
    <div className="min-w-0 py-1">
      <ol className="m-0 grid list-none gap-2 p-0">
        {visible.map((hit, i) => {
          const host = hit.url ? hostFromUrl(hit.url) : null;
          // Search hits come from the tool's upstream results, so the scheme
          // is not ours to trust — an unsafe one renders as plain text.
          const href = safeExternalHref(hit.url);
          return (
            <li key={`${hit.url || hit.title}-${i}`} className="flex min-w-0 items-center gap-2.5">
              {hit.url ? <SiteFavicon url={hit.url} /> : null}
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90 hover:text-foreground hover:underline transition-colors"
                  title={hit.title || hit.url}
                >
                  {hit.title || host || hit.url}
                </a>
              ) : (
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
                  {hit.title || hit.url}
                </span>
              )}
              {host ? (
                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/60">{host}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-2 w-full border-t border-border/20 pt-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          data-testid="search-results-show-more"
        >
          Show {hidden} more result{hidden === 1 ? '' : 's'}
        </button>
      )}
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
            className="flex min-h-[32px] w-full items-center justify-between px-3.5 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground group cursor-pointer"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
              <span className="shrink-0 font-normal">Searched the web</span>
              {query && query !== 'Search' ? (
                <span className="truncate font-medium text-foreground/90" title={query}>
                  {query}
                </span>
              ) : null}
            </span>
            <span className="ml-2 flex shrink-0 items-center gap-2">
              <span className="font-mono text-[10.5px] text-muted-foreground/60">
                {count} result{count === 1 ? '' : 's'}
              </span>
              {open ? (
                <ChevronDown className="size-3 text-muted-foreground/60 group-hover:text-foreground transition-colors" aria-hidden />
              ) : (
                <ChevronRight className="size-3 text-muted-foreground/60 group-hover:text-foreground transition-colors" aria-hidden />
              )}
            </span>
          </button>
        </TaskTrigger>
        <TaskContent className="border-t border-border/20 px-3.5 py-2">
          <SearchResultsList hits={hits} />
        </TaskContent>
      </Task>
    </div>
  );
}
