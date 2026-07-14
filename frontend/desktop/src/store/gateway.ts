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
    useGatewayStore.setState({
      gateway: { status: 'closed', reason: e instanceof Error ? e.message : String(e) },
    });
  }
}

if (typeof window !== 'undefined') {
  void poll();
  setInterval(() => { void poll(); }, 5_000);
}
