import { useQueryClient } from '@tanstack/react-query';
import { WifiOff, AlertTriangle } from 'lucide-react';
import { useGatewayStore } from '@/store/gateway';
import { Backdrop } from './Backdrop';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function ProxyStatusOverlay() {
  const state = useGatewayStore((s) => s.gateway);
  const qc = useQueryClient();
  if (state.status === 'open') return null;

  if (state.status === 'connecting') {
    return (
      <Backdrop>
        <div
          className="w-[min(90vw,420px)] rounded-lg border border-border bg-card p-6 space-y-3"
          role="status"
          aria-label="Connecting to proxy"
        >
          <Skeleton className="h-5 w-44 mx-auto" />
          <Skeleton className="h-3 w-56 mx-auto" />
          <div className="space-y-2 pt-2">
            <Skeleton className="h-8 w-full rounded-md" />
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
          <p className="sr-only">Connecting to proxy… Waiting for /health</p>
        </div>
      </Backdrop>
    );
  }

  const message = state.status === 'error' ? state.message : state.reason ?? 'Connection refused';
  const Icon = state.status === 'error' ? AlertTriangle : WifiOff;
  return (
    <Backdrop>
      <div className="w-[min(90vw,480px)] rounded-lg border border-border bg-card p-6 text-center shadow-2xl">
        <Icon className="size-10 mx-auto mb-3 text-muted-foreground" />
        <h2 className="text-base font-semibold">Proxy is offline</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">{message}</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button variant="outline" onClick={() => window.open('http://localhost:8085/', '_blank')}>
            Open in browser
          </Button>
          <Button onClick={() => { void qc.invalidateQueries(); }}>Retry</Button>
        </div>
      </div>
    </Backdrop>
  );
}
