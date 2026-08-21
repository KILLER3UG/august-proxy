interface WorkingIndicatorProps {
  className?: string;
}

function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(' ');
}

/** Bouncing AUG letters above the composer while a turn is streaming. */
export function WorkingIndicator({ className }: WorkingIndicatorProps) {
  return (
    <div
      className={cn('flex items-center gap-1 py-1', className)}
      role="status"
      aria-live="polite"
      aria-label="August is working"
      data-aug-indicator
    >
      <span className="size-1.5 rounded-full bg-primary/70 animate-pulse" />
      <span className="text-[11px] tracking-wide text-muted-foreground/70">Working</span>
    </div>
  );
}
