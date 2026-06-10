import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * DisclosureRow — collapsible row with hover-only caret
 *
 * Collapsible header with a hover-only caret on the right side.
 * The click target is a content-shaped pill (sized to title text, not full row).
 */
export function DisclosureRow({
  children,
  onToggle,
  open,
  trailing,
}: {
  children: ReactNode;
  onToggle?: () => void;
  open: boolean;
  trailing?: ReactNode;
}) {
  return (
    <div className="group/disclosure-row relative flex w-full max-w-full min-w-0 text-muted-foreground">
      <button
        aria-expanded={onToggle ? open : undefined}
        className={cn(
          'flex min-w-0 max-w-fit items-start gap-1.5 text-left transition-colors',
          onToggle
            ? 'hover:text-foreground focus-visible:text-foreground focus-visible:outline-none'
            : 'cursor-default'
        )}
        disabled={!onToggle}
        onClick={onToggle}
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
      {trailing && (
        <span className="absolute right-1 top-0 flex h-5 items-center">{trailing}</span>
      )}
    </div>
  );
}

function DisclosureCaret({ open }: { open: boolean }) {
  return (
    <svg
      className={cn(
        'size-3.5 shrink-0 transition-transform duration-200 text-muted-foreground',
        open && 'rotate-90'
      )}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
