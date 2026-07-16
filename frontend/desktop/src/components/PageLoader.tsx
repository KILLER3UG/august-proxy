import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type Props = {
  label?: string;
  className?: string;
  /** Compact list-style skeleton (default). Use "card" for denser panels. */
  variant?: 'list' | 'card' | 'form';
};

export function PageLoader({ label, className, variant = 'list' }: Props) {
  return (
    <div
      className={cn('w-full space-y-3 p-6', className)}
      role="status"
      aria-label={label || 'Loading'}
      data-testid="page-loader-skeleton"
    >
      {label ? (
        <p className="sr-only">{label}</p>
      ) : null}
      {variant === 'form' ? (
        <>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-64" />
          <div className="space-y-3 pt-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-9 w-full rounded-md" />
              </div>
            ))}
          </div>
        </>
      ) : variant === 'card' ? (
        <>
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-3 w-56" />
          <div className="grid gap-3 pt-2 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-xl" />
            ))}
          </div>
        </>
      ) : (
        <>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-64 max-w-full" />
          <div className="space-y-2 pt-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton
                key={i}
                className="h-10 w-full rounded-md"
                style={{ opacity: 1 - i * 0.12 }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
