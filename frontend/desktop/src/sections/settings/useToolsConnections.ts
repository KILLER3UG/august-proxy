/* ── useToolsConnections — shared data layer for the Tools & Connections
 *   section ──────────────────────────────────────────────────────────
 * The old Services.tsx and Connections.tsx components each independently
 * polled /api/service-connections (and Connections also polled
 * /ui/host-agent/status). This hook is the only fetcher; both the new
 * Overview cards and the modern Accounts subtab read from one cycle. The
 * Servers subtab still mounts the existing <Mcp /> component (a 1200-line
 * CRUD UI we deliberately preserve rather than rewrite) which keeps its
 * own internal polling for MCP server configs. */

import { useQuery } from '@tanstack/react-query';
import { getHostAgentStatus, type HostAgentStatus } from '@/api/api-client';
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
      ...(c as ServiceConnection),
      // Fill in label/description if the backend omits them.
      label: c.label ?? SERVICE_LABELS[c.name as ServiceName] ?? c.name,
      description: c.description ?? SERVICE_DESCRIPTIONS[c.name as ServiceName] ?? '',
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
    host: (hostQuery.data ?? { status: 'unknown' }) as HostAgentStatus,
    hostConnected,
    hostStatus,
    isLoading: connsQuery.isLoading && hostQuery.isLoading,
  };
}
