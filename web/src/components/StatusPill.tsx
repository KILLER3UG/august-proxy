import { cn } from '@/lib/utils';
import { StatusDot, type StatusTone } from './StatusDot';

interface Props {
  tone: StatusTone;
  label: string;
  className?: string;
}

export function StatusPill({ tone, label, className }: Props) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-0.5 text-xs font-medium text-foreground',
        className,
      )}
    >
      <StatusDot tone={tone} />
      {label}
    </span>
  );
}
