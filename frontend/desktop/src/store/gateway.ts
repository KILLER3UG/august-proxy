import { create } from 'zustand';
import { api } from '@/api/client';

export type GatewayState =
  | { status: 'connecting' }
  | { status: 'open'; port: number; uptime: number }
  | { status: 'closed'; reason?: string }
  | { status: 'error'; message: string };

interface GatewayStoreState {
  gateway: GatewayState;
}

export const useGatewayStore = create<GatewayStoreState>(() => ({
  gateway: { status: 'connecting' },
}));

/** Nanostores-shaped shim for imperative get/set callers. */
export const $gateway = {
  get: (): GatewayState => useGatewayStore.getState().gateway,
  set: (gateway: GatewayState): void => {
    useGatewayStore.setState({ gateway });
  },
  subscribe: (listener: (gateway: GatewayState) => void): (() => void) => {
    listener(useGatewayStore.getState().gateway);
    return useGatewayStore.subscribe((s) => listener(s.gateway));
  },
};

export interface GatewayHealth {
  port?: number;
  uptime?: number;
}

async function poll() {
  try {
    const data = await api.get<GatewayHealth>('/api/health');
    useGatewayStore.setState({
      gateway: { status: 'open', port: data.port ?? 0, uptime: data.uptime ?? 0 },
    });
  } catch (e) {
    const current = useGatewayStore.getState().gateway.status;
    // Stay on "connecting" during first-launch bootstrap so the setup
    // overlay keeps animating instead of flashing "Proxy is offline".
    if (current === 'connecting') {
      return;
    }
    useGatewayStore.setState({
      gateway: { status: 'closed', reason: e instanceof Error ? e.message : String(e) },
    });
  }
}

if (typeof window !== 'undefined') {
  void (async () => {
    // Give the backend supervisor time to bootstrap on first launch.
    for (let i = 0; i < 60; i++) {
      await poll();
      if (useGatewayStore.getState().gateway.status === 'open') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (useGatewayStore.getState().gateway.status === 'connecting') {
      useGatewayStore.setState({
        gateway: { status: 'closed', reason: 'Backend did not become ready in time' },
      });
    }
  })();
  setInterval(() => { void poll(); }, 5_000);
}
