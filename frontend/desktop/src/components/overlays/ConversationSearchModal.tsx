/* ── ConversationSearchModal — FTS search across conversations (C8) ──── */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquareText, Search, X } from 'lucide-react';
import { api } from '@/api/client';
import {
  useConversationSearchStore,
  closeConversationSearch,
} from '@/store/conversation-search';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface SearchHit {
  sessionId: string;
  title: string;
  role?: string;
  snippet?: string;
  messageId?: number;
}

export function ConversationSearchModal() {
  const open = useConversationSearchStore((s) => s.open);
  const navigate = useNavigate();
  const trapRef = useFocusTrap<HTMLDivElement>();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setResults([]);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !q.trim()) {
      setResults([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearching(true);
      void api
        .get<{ results: SearchHit[] }>(
          `/api/sessions/search?q=${encodeURIComponent(q.trim())}`,
        )
        .then((res) => setResults(res.results ?? []))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q, open]);

  if (!open) return null;

  const go = (hit: SearchHit) => {
    closeConversationSearch();
    navigate(`/c/${hit.sessionId}`);
  };

  return (
    <div
      ref={trapRef}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-24"
      role="dialog"
      aria-modal="true"
      aria-label="Search conversations"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeConversationSearch();
      }}
      data-testid="conversation-search-modal"
    >
      <div className="w-full max-w-xl rounded-xl border border-border bg-popover p-3 shadow-xl space-y-2">
        <div className="flex items-center gap-2">
          <Search className="size-4 text-primary shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeConversationSearch();
            }}
            className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Search all conversations…"
            aria-label="Search conversations"
            data-testid="conversation-search-input"
          />
          {searching ? (
            <span className="text-[10px] text-muted-foreground animate-pulse">searching…</span>
          ) : null}
          <button
            type="button"
            onClick={closeConversationSearch}
            className="p-1 rounded text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-3.5" />
          </button>
        </div>

        {q.trim() ? (
          results.length === 0 ? (
            <p className="px-1 py-3 text-center text-[11px] text-muted-foreground">
              {searching ? 'Searching…' : 'No conversations matched.'}
            </p>
          ) : (
            <ul className="space-y-1 max-h-80 overflow-y-auto">
              {results.map((r) => (
                <li key={r.sessionId}>
                  <button
                    type="button"
                    onClick={() => go(r)}
                    className="w-full rounded-md px-2 py-1.5 text-left hover:bg-muted/50"
                    data-testid={`conversation-search-hit-${r.sessionId}`}
                  >
                    <span className="flex items-center gap-1.5 text-xs font-medium">
                      <MessageSquareText className="size-3 text-muted-foreground shrink-0" />
                      <span className="truncate">{r.title}</span>
                    </span>
                    {r.snippet ? (
                      <span className="block text-[11px] text-muted-foreground line-clamp-2 mt-0.5">
                        {r.snippet}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="px-1 py-3 text-center text-[11px] text-muted-foreground">
            Type to search every conversation (FTS over messages).
          </p>
        )}
      </div>
    </div>
  );
}
