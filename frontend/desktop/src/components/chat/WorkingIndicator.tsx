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
      className={cn('flex items-center gap-0.5 py-1', className)}
      role="status"
      aria-live="polite"
      aria-label="August is working"
      data-aug-indicator
    >
      {['A', 'U', 'G'].map((char) => (
        <span
          key={char}
          className="aug-letter text-lg font-bold text-primary"
        >
          {char}
        </span>
      ))}
      <span className="aug-caret text-lg font-bold text-primary/60">|</span>
    </div>
  );
}
