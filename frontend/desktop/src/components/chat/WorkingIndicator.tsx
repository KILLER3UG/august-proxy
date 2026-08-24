interface WorkingIndicatorProps {
  className?: string;
}

function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(' ');
}

const LETTERS = ['A', 'U', 'G', 'U', 'S', 'T'];

/** Bouncing AUGUST wordmark above the composer while a turn is streaming. */
export function WorkingIndicator({ className }: WorkingIndicatorProps) {
  return (
    <div
      className={cn('flex items-center justify-center gap-[3px] py-1', className)}
      role="status"
      aria-live="polite"
      aria-label="Assistant is working"
      data-aug-indicator
    >
      {LETTERS.map((letter, i) => (
        <span
          key={i}
          className="aug-letter text-[11px] font-semibold tracking-[0.18em] text-muted-foreground/80"
          style={{ animationDelay: `${i * 0.12}s` }}
        >
          {letter}
        </span>
      ))}
      <span className="aug-caret ml-0.5 text-[11px] font-semibold text-primary/70">|</span>
    </div>
  );
}
