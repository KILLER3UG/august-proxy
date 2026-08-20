/* ── TimelineRail — Hermes-style slim prompt markers ──────────── */
/* Long transcripts get a 10px rail at the scroll edge: one dot per user */
/* prompt. Hover shows a preview list; click jumps via VirtualizedList. */

import { useMemo, useState } from 'react';
import type { ChatMessage } from '@/types/chat';

export function TimelineRail({
  messages,
  onJump,
}: {
  messages: ChatMessage[];
  onJump: (messageIndex: number) => void;
}) {
  const [hover, setHover] = useState(false);
  const prompts = useMemo(() => {
    const out: Array<{ index: number; preview: string }> = [];
    messages.forEach((m, i) => {
      if (m.role !== 'user') return;
      const p = (m.content || '').trim().replace(/\s+/g, ' ');
      out.push({ index: i, preview: p.length > 72 ? p.slice(0, 72) + '…' : p || '(empty)' });
    });
    return out;
  }, [messages]);

  if (prompts.length < 5) return null;

  return (
    <div
      className="absolute right-1 top-14 bottom-24 z-20 flex w-3 flex-col items-center select-none pointer-events-auto"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label="Conversation timeline"
    >
      {/* Track */}
      <div className="relative flex-1 w-px bg-border/40 my-1 rounded-full" />
      {/* Dots — evenly spaced */}
      <div className="absolute inset-0 flex flex-col justify-between py-1 pointer-events-none">
        {prompts.map((p) => (
          <div key={p.index} className="flex justify-center pointer-events-auto">
            <button
              type="button"
              onClick={() => onJump(p.index)}
              title={p.preview}
              className="size-1.5 rounded-full bg-muted-foreground/30 hover:bg-primary hover:ring-2 hover:ring-primary/20 transition"
              aria-label={`Jump to: ${p.preview}`}
            />
          </div>
        ))}
      </div>

      {/* Hover preview */}
      {hover && (
        <div className="absolute right-3 top-0 max-h-[60vh] w-64 overflow-auto rounded-lg border border-border/60 bg-popover shadow-xl p-1.5">
          <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Prompts · {prompts.length}</div>
          {prompts.map((p, n) => (
            <button
              key={p.index}
              type="button"
              onClick={() => onJump(p.index)}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left hover:bg-muted/60 transition"
            >
              <span className="mt-0.5 text-[10px] tabular-nums text-muted-foreground/60">{n + 1}</span>
              <span className="flex-1 text-[11px] leading-snug text-foreground/80 line-clamp-2">{p.preview}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
