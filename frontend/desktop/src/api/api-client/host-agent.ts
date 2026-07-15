/* Host-agent connectivity and last computer-use / observation telemetry. */

import { api } from '../client';

export interface HostAgentHealth {
  status: 'connected' | 'disconnected' | 'error';
  lastComputerActionAt: string | null;
  lastComputerAction: string | null;
  lastComputerTarget: string | null;
  lastObservationAt: string | null;
  lastObservedApp: string | null;
  postObservationCount: number;
  at: string;
}

export function getHostAgentHealth(): Promise<HostAgentHealth> {
  return api.get<HostAgentHealth>('/api/host-agent/health');
}
