/* ── PromptDisclosure ─ collapsible "PROMPT" row ──────────────────── */
/* Mirrors the ZCode reference: a small uppercase trigger chip that      */
/* expands to show the full system + user prompt that was sent to the   */
/* model. Default collapsed; clicking the trigger toggles the body.      */
/*                                                                       */
/* This pairs with the `prompt` SSE event emitted by the workbench      */
/* backend at the start of each turn.                                    */

import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PromptDisclosureProps {
  /** Full prompt text (system + user). */
  content: string;
  /** Optional token estimate shown in the trigger. */
  tokens?: number;
  /** Optional override label. */
  label?: string;
  className?: string;
}

export function PromptDisclosure({ content, tokens, label = 'PROMPT', className }: PromptDisclosureProps) {
  const [open, setOpen] = useState(false);
  if (!content) return null;

  return (
    <div className={cn('my-1', className)}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cn(
          'group inline-flex items-center gap-1 text-[10.5px] uppercase tracking-[0.07em]',
          'text-muted-foreground/70 hover:text-foreground transition-colors'
        )}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <FileText size={11} />
        <span className="font-medium">{label}</span>
        {typeof tokens === 'number' && (
          <span className="ml-1 text-muted-foreground/50 normal-case tracking-normal">
            · ~{Math.round(tokens).toLocaleString()} tokens
          </span>
        )}
      </button>
      {open && (
        <pre
          className="mt-1 max-h-96 overflow-auto rounded-md border border-white/[0.06] bg-black/30 px-3 py-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap wrap-break-word text-muted-foreground/85"
        >
          {content}
        </pre>
      )}
    </div>
  );
}
