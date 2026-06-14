import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Separator = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { orientation?: 'horizontal' | 'vertical' }>(
  function Separator({ className, orientation = 'horizontal', ...props }, ref) {
    return (
      <div
        ref={ref}
        role="separator"
        className={cn(
          'shrink-0 bg-border',
          orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
          className,
        )}
        {...props}
      />
    );
  },
);
