/* ── RightDrawerNotesSection ─ per-session scratch notepad ────────── */
/* Autosaved to localStorage; a lightweight place to keep plans,      */
/* snippets, and scratch thoughts beside the chat. A "promote" action  */
/* saves the note into the memory store so the model can find it via   */
/* brain_query(store=memory) in any future session.                    */

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Bookmark, Loader2, StickyNote } from 'lucide-react';
import { api } from '@/api/client';

function notesKey(sessionId: string | null): string {
  return `august_notes_${sessionId ?? 'default'}`;
}

export function RightDrawerNotesSection({ sessionId }: { sessionId: string | null }) {
  const [value, setValue] = useState<string>(() =>
    localStorage.getItem(notesKey(sessionId)) ?? '',
  );
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [promoting, setPromoting] = useState(false);
  const saveTimer = useRef<number | null>(null);

  // Switching sessions loads that session's notes.
  useEffect(() => {
    setValue(localStorage.getItem(notesKey(sessionId)) ?? '');
  }, [sessionId]);

  // Debounced autosave.
  useEffect(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      localStorage.setItem(notesKey(sessionId), value);
      setSavedAt(Date.now());
    }, 400);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [value, sessionId]);

  const words = value.trim() ? value.trim().split(/\s+/).length : 0;

  /** Promote the current note into the memory store under a searchable
   *  `note:` key — brain_query(store=memory) finds it in any future session. */
  const promote = async () => {
    const text = value.trim();
    if (!text) {
      toast.info('Write something first — the note is empty.');
      return;
    }
    setPromoting(true);
    try {
      const key = `note:${(sessionId ?? 'default').slice(0, 24)}:${Date.now()}`;
      await api.post('/api/memory/kv', { key, value: text });
      toast.success('Promoted to memory — the model can find it via brain_query(store=memory)');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Promote failed');
    } finally {
      setPromoting(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-2 drawer-section-text">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={
          'Scratch notes for this chat…\n\nPlans, snippets, things to check — autosaved as you type.'
        }
        className="flex-1 min-h-0 w-full resize-none rounded-lg border border-border/60 bg-card/40 p-3 text-[13px] leading-relaxed text-foreground/90 outline-none placeholder:text-muted-foreground/50 focus:border-primary/40"
        spellCheck={false}
      />
      <div className="flex items-center justify-between text-[10px] text-muted-foreground/70">
        <span className="inline-flex items-center gap-1">
          <StickyNote className="size-3" />
          {words} word{words === 1 ? '' : 's'}
        </span>
        <span className="inline-flex items-center gap-2">
          <button
            type="button"
            onClick={() => void promote()}
            disabled={promoting || !value.trim()}
            title="Save this note into memory — searchable via brain_query(store=memory) in any session"
            className="inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-primary/40 hover:text-primary disabled:opacity-40"
            data-testid="promote-note-to-memory"
          >
            {promoting ? (
              <Loader2 className="size-2.5 animate-spin" />
            ) : (
              <Bookmark className="size-2.5" />
            )}
            Promote to memory
          </button>
          <span>{savedAt ? 'Saved' : 'Autosaves as you type'}</span>
        </span>
      </div>
    </div>
  );
}
