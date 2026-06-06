import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Backdrop({ children, onClose, className }: {
  children: ReactNode;
  onClose?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 backdrop-blur-sm',
        className,
      )}
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="relative">
        {children}
      </div>
    </div>
  );
}
