import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusPill } from '@/components/StatusPill';
import { Button } from '@/components/ui/button';
import { Server, Plug, ArrowRight, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { getHostAgentStatus } from '@/api/api-client';
import { api } from '@/api/client';

/* ── Service connection read shape (mirrors Services.tsx, narrowed) ── */
interface ServiceConnection {
  name: string;
  connected: boolean;
  account?: string;
  scopes?: string[];
  status?: string;
}

interface ServiceConnectionsResponse {
  connections: Partial<Record<string, ServiceConnection>>;
}

const SERVICE_LABELS: Record<string, string> = {
  google: 'Google Workspace',
  github: 'GitHub',
  slack: 'Slack',
};

export function Connections() {
  const [params, setParams] = useSearchParams();

  const { data: hostData } = useQuery({
    queryKey: ['host-agent-status'],
    queryFn: () => getHostAgentStatus(),
    refetchInterval: 5_000,
  });
  const { data: svcData } = useQuery({
    queryKey: ['service-connections-summary'],
    queryFn: () => api.get<ServiceConnectionsResponse>('/api/service-connections'),
    refetchInterval: 8_000,
  });

  const connections = Object.values(svcData?.connections || {}) as ServiceConnection[];
  const connectedCount = connections.filter((c) => c.connected).length;
  const hostStatus = hostData?.status || 'unknown';
  const hostConnected = hostStatus === 'connected' || hostStatus === 'open';

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Connections"
        subtitle={`${connectedCount}/${connections.length} services connected · host agent ${hostStatus}`}
        actions={
          <Button variant="outline" size="sm" onClick={() => setParams({ tab: 'mcp' })}>
            <Plug className="size-3" /> Manage in MCP
          </Button>
        }
      />

      {/* Host agent */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Server className="size-4" /> Host agent
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {hostConnected ? (
              <Wifi className="size-5 text-success" />
            ) : (
              <WifiOff className="size-5 text-muted-foreground" />
            )}
            <div>
              <StatusPill
                tone={hostConnected ? 'good' : 'muted'}
                label={hostStatus}
              />
              <p className="text-xs text-muted-foreground mt-1">
                {hostConnected
                  ? 'Host agent is reachable and accepting commands.'
                  : 'Host agent is not running. Start it to enable file and terminal operations.'}
              </p>
            </div>
          </div>
          <RefreshCw className="size-3.5 text-muted-foreground/50" />
        </CardContent>
      </Card>

      {/* Service connections summary */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Service connections</h3>
          <button
            onClick={() => setParams({ tab: 'mcp' })}
            className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition"
          >
            Open Services <ArrowRight className="size-3" />
          </button>
        </div>
        {connections.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              No service connections configured. Use the Services tab to connect Google, GitHub, or Slack.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {connections.map((c) => (
              <Card key={c.name} className={c.connected ? '' : 'opacity-70'}>
                <CardContent className="p-3 flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{SERVICE_LABELS[c.name] || c.name}</span>
                      <Badge variant={c.connected ? 'outline' : 'secondary'} className="text-[9px]">
                        {c.connected ? 'connected' : 'disconnected'}
                      </Badge>
                    </div>
                    {c.connected && c.account && (
                      <p className="text-[11px] text-muted-foreground font-mono truncate mt-0.5">{c.account}</p>
                    )}
                    {c.connected && c.scopes && c.scopes.length > 0 && (
                      <p className="text-[10px] text-muted-foreground/60 font-mono truncate mt-0.5">
                        {c.scopes.length} scopes
                      </p>
                    )}
                  </div>
                  {!c.connected && (
                    <Button size="sm" variant="outline" onClick={() => setParams({ tab: 'mcp' })}>
                      Connect
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
      <p className="text-[9px] text-muted-foreground font-mono">
        🔒 Account credentials and tokens are never displayed. Manage OAuth/tokens in the Services tab.
      </p>
    </div>
  );
}
