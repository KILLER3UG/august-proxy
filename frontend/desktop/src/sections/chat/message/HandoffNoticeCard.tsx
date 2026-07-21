import { useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DisclosureRow } from '@/components/chat/DisclosureRow';

/**
 * Collapsed transcript card shown after a model switch that carried context
 * forward. Mirrors the tool-card / ThinkingDisclosure look: a small header
 * row that expands to reveal the handoff brief the next model received.
 */
export function HandoffNoticeCard({
  fromModel,
  toModel,
  summary,
}: {
  fromModel?: string;
  toModel?: string;
  summary: string;
}) {
  const [open, setOpen] = useState(false);
  const label = fromModel ? `Context carried over from ${fromModel}` : 'Context carried over from the previous model';

  return (
    <div className="text-sm text-muted-foreground w-full py-0.5" data-slot="handoff-notice">
      <DisclosureRow onToggle={() => setOpen(!open)} open={open}>
        <span className="flex min-w-0 items-center gap-2">
          <ArrowRightLeft className="size-3.5 shrink-0 text-muted-foreground/80" />
          <span className="text-[12.5px] font-medium leading-5 text-muted-foreground/85">
            {label}
            {toModel && <span className="text-muted-foreground/55"> → {toModel}</span>}
          </span>
        </span>
      </DisclosureRow>
      {open && (
        <div
          className={cn(
            'ml-5 mt-1 mb-1 rounded-lg border border-border/50 bg-muted/20 px-3 py-2',
            'text-[12.5px] leading-relaxed text-muted-foreground/80 whitespace-pre-wrap wrap-anywhere',
            'max-h-48 overflow-y-auto',
          )}
        >
          {summary}
        </div>
      )}
    </div>
  );
}
