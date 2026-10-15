import { ChevronRight } from 'lucide-react';
import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

/**
 * DisclosureRow — collapsible row with hover-only caret
 *
 * Collapsible header with a hover-only caret on the right side.
 * The click target is a content-shaped pill (sized to title text, not full row).
 *
 * Built on the same Radix base as `components/ui/task.tsx` (B4's "one component"):
 * the row IS a disclosure now, not a button that a parent happens to pair with a
 * conditionally-rendered body. `content` is optional so the eight existing callers
 * keep their current markup untouched — each one that passes it gets
 * `aria-controls`, a real `aria-expanded`, and a body Radix hides rather than a
 * subtree silently absent from the DOM.
 */
export function DisclosureRow({
  children,
  onToggle,
  open,
  trailing,
  content,
}: {
  children: ReactNode;
  onToggle?: () => void;
  open: boolean;
  trailing?: ReactNode;
  content?: ReactNode;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={() => onToggle?.()}
      className="group/disclosure-row relative flex w-full max-w-full min-w-0 flex-col text-muted-foreground"
    >
      <div className="flex w-full min-w-0 items-start">
        <CollapsibleTrigger asChild disabled={!onToggle}>
          <button
            aria-expanded={onToggle ? open : undefined}
            className={cn(
              'flex min-w-0 max-w-fit items-start gap-1.5 text-left transition-colors',
              onToggle
                ? 'hover:text-foreground focus-visible:text-foreground focus-visible:outline-none'
                : 'cursor-default'
            )}
            disabled={!onToggle}
            type="button"
          >
            <span className="flex min-w-0 flex-col gap-0.5">{children}</span>
            {onToggle && (
              <span
                className={cn(
                  'flex h-5 shrink-0 items-center justify-center transition-opacity duration-150',
                  open
                    ? 'opacity-80'
                    : 'opacity-0 group-hover/disclosure-row:opacity-80 group-focus-within/disclosure-row:opacity-80'
                )}
              >
                <DisclosureCaret open={open} />
              </span>
            )}
          </button>
        </CollapsibleTrigger>
        {trailing && (
          <span className="ml-auto flex h-5 shrink-0 items-center pr-1">{trailing}</span>
        )}
      </div>
      {content !== undefined && <CollapsibleContent>{content}</CollapsibleContent>}
    </Collapsible>
  );
}

function DisclosureCaret({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={cn(
        'size-3 shrink-0 transition-transform duration-200 text-muted-foreground',
        open && 'rotate-90'
      )}
      strokeWidth={2}
    />
  );
}
