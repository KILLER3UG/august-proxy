import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export type StatusTone = 'good' | 'muted' | 'warn' | 'bad';

const TONE_BG: Record<StatusTone, string> = {
  good:  'bg-primary',
  muted: 'bg-muted-foreground/40',
  warn:  'bg-warning',
  bad:   'bg-destructive',
};

export function StatusDot({ className, tone, ...props }: ComponentProps<'span'> & { tone: StatusTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-1.5 rounded-full', TONE_BG[tone], className)}
      {...props}
    />
  );
}
