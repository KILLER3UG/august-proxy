/* ── useToolsConnections — shared data layer for the Tools & Connections
 *   section ──────────────────────────────────────────────────────────
 * Single fetcher for /api/service-connections and /api/host-agent/health.
 * Overview cards and the Accounts subtab share one poll cycle. The Servers
 * subtab mounts <Mcp /> which polls /api/mcp/servers for configs. */

import { useQuery } from '@tanstack/react-query';
import { getHostAgentStatus } from '@/api/api-client';
import { api } from '@/api/client';

export type ServiceName = 'google' | 'github' | 'slack';
export type ServiceStatus = 'connected' | 'disconnected' | 'needs_config';

export interface ServiceConnection {
  name: ServiceName;
  label: string;
  description: string;
  services: string[];
  scopes: string[];
  status: ServiceStatus;
  connected: boolean;
  account?: string;
  maskedToken?: string;
  teamId?: string;
  missingConfig?: boolean;
  updatedAt?: string;
}

interface ServiceConnectionsResponse {
  connections: Partial<Record<ServiceName, ServiceConnection>>;
}

const SERVICE_LABELS: Record<ServiceName, string> = {
  google: 'Google Workspace',
  github: 'GitHub',
  slack: 'Slack',
};

const SERVICE_DESCRIPTIONS: Record<ServiceName, string> = {
  google: 'Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks, Contacts.',
  github: 'Repositories, issues, pull requests, and code search.',
  slack: 'Channels, messages, threads, and reactions.',
};

export function useToolsConnections() {
  const connsQuery = useQuery({
    queryKey: ['tc-connections'],
    queryFn: () => api.get<ServiceConnectionsResponse>('/api/service-connections'),
    refetchInterval: 8_000,
  });
  const hostQuery = useQuery({
    queryKey: ['tc-host-agent'],
    queryFn: () => getHostAgentStatus(),
    refetchInterval: 5_000,
  });

  const connections: ServiceConnection[] = Object.values(connsQuery.data?.connections ?? {}).map(
    (c) => ({
      ...(c),
      // Fill in label/description if the backend omits them.
      label: c.label ?? SERVICE_LABELS[c.name] ?? c.name,
      description: c.description ?? SERVICE_DESCRIPTIONS[c.name] ?? '',
    }),
  );
  const hostStatus = hostQuery.data?.status ?? 'unknown';
  const hostConnected = hostStatus === 'connected' || hostStatus === 'open';
  const connectedCount = connections.filter((c) => c.connected).length;
  const totalCount = connections.length;

  return {
    connections,
    connectedCount,
    totalCount,
    host: (hostQuery.data ?? { status: 'unknown' }),
    hostConnected,
    hostStatus,
    isLoading: connsQuery.isLoading && hostQuery.isLoading,
  };
}
