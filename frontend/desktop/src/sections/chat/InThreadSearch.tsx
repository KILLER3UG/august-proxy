/* ── InThreadSearch ──────────────────────────────────────────────────── */
/* Floating search bar for finding text within the current conversation. */
/* Activated via Ctrl+F / Cmd+F; Escape to close, Enter for next match. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface InThreadSearchProps {
  /** Total number of messages in the thread. */
  messageCount: number;
  /** Callback to highlight matches in message content. Returns the number
   *  of matches found (the pane counts them from its own index list). */
  onSearch: (query: string) => number;
  /** Callback to scroll to a specific match index. */
  onNavigate: (matchIndex: number) => void;
  /** Callback to clear all highlights. */
  onClear: () => void;
}

export function InThreadSearch({
  messageCount,
  onSearch,
  onNavigate,
  onClear,
}: InThreadSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClose = useCallback(() => {
    setOpen(false);
    setQuery('');
    setMatchCount(0);
    setCurrentMatch(0);
    onClear();
  }, [onClear]);

  // Focus input when opened.
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Ctrl+F / Cmd+F to open.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        // Only intercept if we're in a chat view (messageCount > 0).
        if (messageCount > 0) {
          e.preventDefault();
          setOpen(true);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [messageCount]);

  // Escape to close.
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, handleClose]);

  const handleSearch = useCallback(
    (value: string) => {
      setQuery(value);
      if (value.trim()) {
        const count = onSearch(value);
        setMatchCount(count);
        setCurrentMatch(count > 0 ? 1 : 0);
        if (count > 0) {
          onNavigate(0);
        }
      } else {
        setMatchCount(0);
        setCurrentMatch(0);
        onClear();
      }
    },
    [onSearch, onNavigate, onClear],
  );

  const navigateMatch = useCallback(
    (direction: 'next' | 'prev') => {
      if (matchCount === 0) return;
      let next: number;
      if (direction === 'next') {
        next = currentMatch >= matchCount ? 1 : currentMatch + 1;
      } else {
        next = currentMatch <= 1 ? matchCount : currentMatch - 1;
      }
      setCurrentMatch(next);
      onNavigate(next - 1);
    },
    [matchCount, currentMatch, onNavigate],
  );

  // Enter for next, Shift+Enter for previous.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          navigateMatch('prev');
        } else {
          navigateMatch('next');
        }
      }
    },
    [navigateMatch],
  );

  if (!open) return null;

  return (
    <div
      className="absolute top-2 right-4 z-50 flex items-center gap-1.5 bg-card border border-border rounded-lg shadow-lg px-3 py-2"
      data-testid="in-thread-search"
    >
      <Search className="size-3.5 text-muted-foreground shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={e => handleSearch(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search in thread…"
        className="w-48 text-sm bg-transparent border-none outline-none placeholder:text-muted-foreground"
      />
      {matchCount > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
          {currentMatch}/{matchCount}
        </span>
      )}
      <button
        onClick={() => navigateMatch('prev')}
        disabled={matchCount === 0}
        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition disabled:opacity-30"
        aria-label="Previous match"
      >
        <ChevronUp className="size-3.5" />
      </button>
      <button
        onClick={() => navigateMatch('next')}
        disabled={matchCount === 0}
        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition disabled:opacity-30"
        aria-label="Next match"
      >
        <ChevronDown className="size-3.5" />
      </button>
      <button
        onClick={handleClose}
        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition"
        aria-label="Close search"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
