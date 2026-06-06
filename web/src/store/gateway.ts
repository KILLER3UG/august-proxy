import { atom } from 'nanostores';

export type GatewayState =
  | { status: 'connecting' }
  | { status: 'open'; port: number; uptime: number }
  | { status: 'closed'; reason?: string }
  | { status: 'error'; message: string };

export const $gateway = atom<GatewayState>({ status: 'connecting' });

export interface GatewayHealth {
  port?: number;
  uptime?: number;
}

async function poll() {
  try {
    const res = await fetch('/health');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as GatewayHealth;
    $gateway.set({ status: 'open', port: data.port ?? 0, uptime: data.uptime ?? 0 });
  } catch (e) {
    $gateway.set({ status: 'closed', reason: e instanceof Error ? e.message : String(e) });
  }
}

if (typeof window !== 'undefined') {
  void poll();
  setInterval(poll, 5_000);
}
