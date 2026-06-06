import { useStore } from '@nanostores/react';
import { useQueryClient } from '@tanstack/react-query';
import { WifiOff, AlertTriangle, Loader2 } from 'lucide-react';
import { $gateway } from '@/store/gateway';
import { Backdrop } from './Backdrop';
import { Button } from '@/components/ui/button';

export function ProxyStatusOverlay() {
  const state = useStore($gateway);
  const qc = useQueryClient();
  if (state.status === 'open') return null;

  if (state.status === 'connecting') {
    return (
      <Backdrop>
        <div className="w-[min(90vw,420px)] rounded-lg border border-border bg-card p-6 text-center">
          <Loader2 className="size-8 mx-auto mb-3 text-muted-foreground animate-spin" />
          <h2 className="text-sm font-semibold">Connecting to proxy…</h2>
          <p className="mt-1 text-xs text-muted-foreground">Waiting for <code className="font-mono">/health</code></p>
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
          <Button onClick={() => qc.invalidateQueries()}>Retry</Button>
        </div>
      </div>
    </Backdrop>
  );
}
