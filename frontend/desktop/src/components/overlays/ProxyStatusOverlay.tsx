import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { WifiOff, AlertTriangle, CircleX } from 'lucide-react';
import { motion } from 'framer-motion';
import { useGatewayStore } from '@/store/gateway';
import { Backdrop } from './Backdrop';
import { Button } from '@/components/ui/button';
import { BackendSetupPlan } from '@/components/ui/backend-setup-plan';
import { isTauri } from '@/lib/tauri-detect';
import { useBackendSetup } from '@/hooks/useBackendSetup';

const MATERIALIZING = new Set(['copying', 'creating_venv', 'installing']);

export function ProxyStatusOverlay() {
  const state = useGatewayStore((s) => s.gateway);
  const qc = useQueryClient();
  const { status: setup } = useBackendSetup();
  const [showReadyFlash, setShowReadyFlash] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (setup.phase !== 'ready') return;
    setShowReadyFlash(true);
    const t = window.setTimeout(() => setShowReadyFlash(false), 1100);
    return () => window.clearTimeout(t);
  }, [setup.phase]);

  const onRetry = async () => {
    setRetrying(true);
    try {
      if (isTauri) {
        try {
          await invoke<string>('restart_proxy');
        } catch {
          /* fall through to query invalidate */
        }
      }
      void qc.invalidateQueries();
    } finally {
      setRetrying(false);
    }
  };

  if (state.status === 'open' && !showReadyFlash) return null;

  // First-launch deps install only — not reconnect / folder switches / "starting".
  const materializing = isTauri && MATERIALIZING.has(setup.phase);

  if (materializing || (showReadyFlash && setup.phase === 'ready')) {
    const headline =
      setup.phase === 'ready'
        ? 'Backend ready'
        : 'Setting up backend';
    const detail =
      setup.detail ||
      (setup.phase === 'ready'
        ? 'You can start chatting.'
        : 'First launch can take a minute while dependencies install.');

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
            <Button disabled={retrying} onClick={() => { void onRetry(); }}>
              {retrying ? 'Retrying…' : 'Retry'}
            </Button>
          </div>
        </motion.div>
      </Backdrop>
    );
  }

  // Still connecting on first paint — stay quiet; BackendBootstrapGate owns that.
  if (state.status === 'connecting') return null;

  const message =
    state.status === 'error'
      ? state.message
      : state.status === 'closed'
        ? state.reason ?? 'Connection refused'
        : 'Connection refused';
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
          <Button disabled={retrying} onClick={() => { void onRetry(); }}>
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      </motion.div>
    </Backdrop>
  );
}
