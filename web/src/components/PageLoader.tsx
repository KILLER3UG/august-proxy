import { Spinner } from '@/components/ui/spinner';

export function PageLoader({ label }: { label?: string }) {
  return (
    <div className="grid h-full place-items-center gap-3 text-sm text-muted-foreground">
      <Spinner size="lg" />
      {label && <p>{label}</p>}
    </div>
  );
}
