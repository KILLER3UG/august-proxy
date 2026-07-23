/* ── RightDrawerNotesSection ─ per-session scratch notepad ────────── */
/* Autosaved to localStorage; a lightweight place to keep plans,      */
/* snippets, and scratch thoughts beside the chat.                    */

import { useEffect, useRef, useState } from 'react';
import { StickyNote } from 'lucide-react';

function notesKey(sessionId: string | null): string {
  return `august_notes_${sessionId ?? 'default'}`;
}

export function RightDrawerNotesSection({ sessionId }: { sessionId: string | null }) {
  const [value, setValue] = useState<string>(() =>
    localStorage.getItem(notesKey(sessionId)) ?? '',
  );
  const [savedAt, setSavedAt] = useState<number | null>(null);
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
        <span>{savedAt ? 'Saved' : 'Autosaves as you type'}</span>
      </div>
    </div>
  );
}
