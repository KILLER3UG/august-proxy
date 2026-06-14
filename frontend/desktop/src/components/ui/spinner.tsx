import { cn } from '@/lib/utils';

interface Props {
  size?: 'sm' | 'default' | 'lg';
  className?: string;
}

export function Spinner({ size = 'default', className }: Props) {
  const dims = size === 'sm' ? 'size-3' : size === 'lg' ? 'size-6' : 'size-4';
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block animate-spin rounded-full border-2 border-current border-t-transparent text-muted-foreground',
        dims,
        className,
      )}
    />
  );
}
