import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WifiOff, AlertTriangle, CircleX } from 'lucide-react';
import { motion } from 'framer-motion';
import { useGatewayStore } from '@/store/gateway';
import { Backdrop } from './Backdrop';
import { Button } from '@/components/ui/button';
import { BackendSetupPlan } from '@/components/ui/backend-setup-plan';
import { isTauri } from '@/lib/tauri-detect';
import { useBackendSetup } from '@/hooks/useBackendSetup';

export function ProxyStatusOverlay() {
  const state = useGatewayStore((s) => s.gateway);
  const qc = useQueryClient();
  const { status: setup } = useBackendSetup();
  const [showReadyFlash, setShowReadyFlash] = useState(false);

  useEffect(() => {
    if (setup.phase !== 'ready') return;
    setShowReadyFlash(true);
    const t = window.setTimeout(() => setShowReadyFlash(false), 1100);
    return () => window.clearTimeout(t);
  }, [setup.phase]);

  if (state.status === 'open' && !showReadyFlash) return null;

  const isBootstrapping =
    isTauri &&
    (setup.phase === 'copying' ||
      setup.phase === 'creating_venv' ||
      setup.phase === 'installing' ||
      setup.phase === 'starting' ||
      (setup.phase === 'ready' && showReadyFlash) ||
      (state.status === 'connecting' && setup.phase !== 'error' && setup.phase !== 'idle'));

  if (state.status === 'connecting' || isBootstrapping || showReadyFlash) {
    const headline =
      setup.phase === 'ready'
        ? 'Backend ready'
        : setup.phase === 'installing' || setup.phase === 'copying' || setup.phase === 'creating_venv'
          ? 'Setting up backend'
          : 'Starting backend';
    const detail =
      setup.detail ||
      (setup.phase === 'ready'
        ? 'You can start chatting.'
        : isTauri
          ? 'First launch can take a minute while dependencies install.'
          : 'Connecting to proxy… Waiting for /health');

    return (
      <Backdrop>
        <BackendSetupPlan setup={setup} headline={headline} detail={detail} />
      </Backdrop>
    );
  }

  if (setup.phase === 'error') {
    return (
      <Backdrop>
        <motion.div
          className="w-[min(90vw,480px)] rounded-lg border border-border bg-card p-6 text-center shadow-2xl"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.2, 0.65, 0.3, 0.9] } }}
        >
          <CircleX className="mx-auto mb-3 size-10 text-red-500" />
          <h2 className="text-base font-semibold">Backend setup failed</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {setup.detail || 'Could not prepare the Python runtime.'}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button onClick={() => { void qc.invalidateQueries(); }}>Retry</Button>
          </div>
        </motion.div>
      </Backdrop>
    );
  }

  const message = state.status === 'error' ? state.message : state.reason ?? 'Connection refused';
  const Icon = state.status === 'error' ? AlertTriangle : WifiOff;
  return (
    <Backdrop>
      <motion.div
        className="w-[min(90vw,480px)] rounded-lg border border-border bg-card p-6 text-center shadow-2xl"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.2, 0.65, 0.3, 0.9] } }}
      >
        <Icon className="mx-auto mb-3 size-10 text-muted-foreground" />
        <h2 className="text-base font-semibold">Proxy is offline</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{message}</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button variant="outline" onClick={() => window.open('http://localhost:8085/', '_blank')}>
            Open in browser
          </Button>
          <Button onClick={() => { void qc.invalidateQueries(); }}>Retry</Button>
        </div>
      </motion.div>
    </Backdrop>
  );
}
