import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition',
  {
    variants: {
      variant: {
        default:     'bg-primary text-primary-foreground',
        secondary:   'bg-secondary text-secondary-foreground',
        destructive: 'bg-destructive text-destructive-foreground',
        outline:     'border border-border text-foreground',
        success:     'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
        warning:     'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLDivElement>,
  VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
