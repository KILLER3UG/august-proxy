/* ── BackendBootstrapGate — block the app until the proxy is healthy ─ */
/* Tauri only. Shows the setup plan animation during first-launch        */
/* bootstrap; surfaces errors with Retry. The main shell is not mounted  */
/* until /api/health succeeds so users never land in a dead UI.          */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CircleX, RefreshCw } from 'lucide-react';
import { motion } from 'framer-motion';
import { isTauri } from '@/lib/tauri-detect';
import { useBackendSetup, type BackendSetupPhase } from '@/hooks/useBackendSetup';
import { BackendSetupPlan } from '@/components/ui/backend-setup-plan';
import { Button } from '@/components/ui/button';
import { $gateway } from '@/store/gateway';

export function BackendBootstrapGate({ children }: { children: ReactNode }) {
  const { status: setup, refresh } = useBackendSetup();
  const [proxyUp, setProxyUp] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [readyFlash, setReadyFlash] = useState(false);

  const poll = useCallback(async () => {
    if (!isTauri) return;
    try {
      const status = await invoke<string>('proxy_status');
      const up = status.startsWith('ok:');
      setProxyUp(up);
      if (up) {
        $gateway.set({ status: 'open', port: Number(status.split(':')[1]) || 8085, uptime: 0 });
      }
    } catch {
      setProxyUp(false);
    }
    try {
      const err = await invoke<string | null>('backend_last_error');
      setLastError(err);
    } catch {
      setLastError(null);
    }
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isTauri) return;
    void poll();
    const id = window.setInterval(() => {
      void poll();
    }, 1000);
    return () => window.clearInterval(id);
  }, [poll]);

  // If the supervisor thread hasn't produced a healthy proxy yet, kick a
  // blocking sync/bootstrap once so phases update and errors surface here.
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    void (async () => {
      await new Promise((r) => setTimeout(r, 400));
      if (cancelled) return;
      try {
        const status = await invoke<string>('proxy_status');
        if (status.startsWith('ok:')) return;
        await invoke<string>('sync_backend_deps');
      } catch {
        /* shown via last_error / setup phase */
      }
      if (!cancelled) await poll();
    })();
    return () => {
      cancelled = true;
    };
  }, [poll]);

  useEffect(() => {
    if (!proxyUp || setup.phase === 'error') return;
    setReadyFlash(true);
    const t = window.setTimeout(() => setReadyFlash(false), 900);
    return () => window.clearTimeout(t);
  }, [proxyUp, setup.phase]);

  const onRetry = useCallback(async () => {
    if (!isTauri) return;
    setRetrying(true);
    try {
      await invoke<string>('restart_proxy');
      // Blocking deps materialize + start (packaged installs).
      try {
        await invoke<string>('sync_backend_deps');
      } catch {
        /* restart_proxy already tried ensureRunning */
      }
      await poll();
    } finally {
      setRetrying(false);
    }
  }, [poll]);

  if (!isTauri) return <>{children}</>;

  const failed = setup.phase === 'error';
  const gated = !proxyUp || failed || readyFlash;

  if (!gated) return <>{children}</>;

  const displaySetup: BackendSetupPhase =
    setup.phase === 'idle' && !failed
      ? { phase: 'starting', detail: 'Starting backend…' }
      : setup;

  const headline = failed
    ? 'Backend setup failed'
    : proxyUp || setup.phase === 'ready'
      ? 'Backend ready'
      : setup.phase === 'installing' || setup.phase === 'copying' || setup.phase === 'creating_venv'
        ? 'Setting up backend'
        : 'Starting backend';

  const detail =
    displaySetup.detail ||
    lastError ||
    (proxyUp
      ? 'You can start chatting.'
      : 'Please wait — August opens after the backend is ready.');

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(255,255,255,0.04),_transparent_55%)]" />
      {failed ? (
        <motion.div
          className="relative w-[min(92vw,480px)] rounded-xl border border-border bg-card p-6 text-center shadow-2xl"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.2, 0.65, 0.3, 0.9] } }}
        >
          <CircleX className="mx-auto mb-3 size-10 text-red-500" />
          <h2 className="text-base font-semibold">{headline}</h2>
          <p className="mx-auto mt-2 max-w-md whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {detail}
          </p>
          {lastError && lastError !== detail ? (
            <p className="mx-auto mt-2 max-h-28 max-w-md overflow-y-auto break-words rounded-lg bg-black/30 p-2 text-left text-[11px] text-red-400/90">
              {lastError}
            </p>
          ) : null}
          <div className="mt-5 flex justify-center gap-2">
            <Button disabled={retrying} onClick={() => { void onRetry(); }}>
              {retrying ? (
                <RefreshCw className="mr-1.5 size-3.5 animate-spin" />
              ) : null}
              {retrying ? 'Retrying…' : 'Retry setup'}
            </Button>
          </div>
        </motion.div>
      ) : (
        <div className="relative">
          <BackendSetupPlan setup={displaySetup} headline={headline} detail={detail} />
          {!proxyUp && (
            <p className="mt-4 text-center text-[11px] text-muted-foreground">
              August will open automatically when the backend is ready.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
