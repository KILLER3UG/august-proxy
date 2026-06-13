import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { SectionHeader } from '@/components/SectionHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Github,
  KeyRound,
  Link,
  Loader2,
  Mail,
  MessageCircle,
  PauseCircle,
  PlayCircle,
  Server,
  Trash2,
  Wrench
} from 'lucide-react';

interface McpServer {
  name: string;
  status: 'running' | 'stopped' | 'disabled' | 'not_started' | 'error';
  toolCount: number;
  enabled: boolean;
  command: string;
  source?: string;
  error?: string | null;
  tools?: string[];
}

type ServiceName = 'google' | 'github' | 'slack';
type ServiceStatus = 'connected' | 'disconnected' | 'needs_config';

interface ServiceConnection {
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

const FALLBACK_SERVICES: ServiceConnection[] = [
  {
    name: 'google',
    label: 'Google Workspace',
    description: 'Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks, Contacts',
    services: ['Gmail read', 'Gmail send', 'Calendar', 'Drive', 'Docs', 'Sheets', 'Slides', 'Tasks', 'Contacts'],
    scopes: ['gmail.read', 'gmail.send', 'calendar', 'drive', 'docs', 'sheets', 'slides', 'tasks', 'contacts'],
    status: 'connected',
    connected: true,
    account: 'robertacepayales69@gmail.com'
  },
  {
    name: 'github',
    label: 'GitHub',
    description: 'Repository access, PRs, issues, releases',
    services: ['Repositories', 'Pull requests', 'Issues', 'Gists'],
    scopes: ['repo', 'read:user', 'workflow', 'gist'],
    status: 'connected',
    connected: true,
    account: 'rober-cepayales'
  },
  {
    name: 'slack',
    label: 'Slack',
    description: 'Messaging, channels, workspace tools',
    services: ['Channels', 'Messages', 'Files', 'Workspace'],
    scopes: [],
    status: 'disconnected',
    connected: false
  }
];

const SERVER_ICONS: Record<string, { icon: string; color: string }> = {
  'blender':        { icon: 'B', color: 'from-orange-500 to-amber-600' },
  'brave-search':   { icon: 'Br', color: 'from-red-500 to-rose-600' },
  'browser-use':    { icon: 'Bu', color: 'from-blue-500 to-cyan-500' },
  'fetch':          { icon: 'F', color: 'from-green-500 to-emerald-500' },
  'filesystem':     { icon: 'Fs', color: 'from-slate-500 to-zinc-600' },
  'github':         { icon: 'Gh', color: 'from-slate-700 to-slate-900' },
  'linear':         { icon: 'Li', color: 'from-indigo-500 to-purple-600' },
  'minimax':        { icon: 'Mm', color: 'from-purple-500 to-violet-600' },
  'n8n':            { icon: 'N', color: 'from-red-600 to-orange-600' },
  'notebooklm-mcp': { icon: 'Nl', color: 'from-sky-500 to-blue-600' },
  'playwright':     { icon: 'Pw', color: 'from-green-600 to-teal-500' },
};

function getStatusMeta(status: string) {
  switch (status) {
    case 'running':
      return { label: 'Running', tone: 'good' as const, icon: CheckCircle2 };
    case 'error':
      return { label: 'Error', tone: 'bad' as const, icon: AlertCircle };
    case 'starting':
      return { label: 'Starting', tone: 'warn' as const, icon: Loader2 };
    case 'disabled':
      return { label: 'Disabled', tone: 'muted' as const, icon: PauseCircle };
    default:
      return { label: 'Stopped', tone: 'muted' as const, icon: PlayCircle };
  }
}

function getServiceIcon(name: ServiceName) {
  switch (name) {
    case 'google': return { icon: Mail, color: 'from-red-500 to-orange-500' };
    case 'github': return { icon: Github, color: 'from-slate-800 to-slate-950 dark:from-slate-100 dark:to-slate-300 dark:text-slate-950' };
    case 'slack': return { icon: MessageCircle, color: 'from-purple-500 to-pink-500' };
  }
}

function getServiceStatusMeta(status: ServiceStatus) {
  switch (status) {
    case 'connected': return { label: 'Connected', tone: 'good' as const, icon: CheckCircle2 };
    case 'needs_config': return { label: 'Needs config', tone: 'warn' as const, icon: AlertCircle };
    default: return { label: 'Disconnected', tone: 'muted' as const, icon: Link };
  }
}

function formatTime(value?: string) {
  if (!value) return undefined;
  try {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
  } catch {
    return undefined;
  }
}

export function Services() {
  const queryClient = useQueryClient();

  const { data: serviceData, isLoading: servicesLoading } = useQuery({
    queryKey: ['service-connections'],
    queryFn: async () => {
      const res = await api.get<ServiceConnectionsResponse>('/api/service-connections');
      return Object.values(res.connections || {}) as ServiceConnection[];
    },
    refetchInterval: 15_000,
  });

  const { data: mcpData, isLoading: mcpLoading } = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: async () => {
      const res = await api.get<{ status: McpServer[] }>('/ui/mcp');
      return res.status ?? [];
    },
    refetchInterval: 15_000,
  });

  const googleAuth = useMutation({
    mutationFn: async (email?: string) => {
      const res = await api.post<{ authUrl: string }>('/api/service-connections/google/auth', { email });
      return res.authUrl;
    },
    onSuccess: (authUrl) => {
      const popup = window.open(authUrl, '_blank', 'width=520,height=760');
      if (!popup) {
        queryClient.invalidateQueries({ queryKey: ['service-connections'] });
      }
    }
  });

  const disconnect = useMutation({
    mutationFn: async (name: ServiceName) => {
      await api.delete(`/api/service-connections/${name}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-connections'] });
    }
  });

  const connectGithub = useMutation({
    mutationFn: async ({ token }: { token: string }) => {
      await api.post('/api/service-connections/github', { token });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-connections'] });
    }
  });

  const connectSlack = useMutation({
    mutationFn: async ({ botToken, teamId }: { botToken: string; teamId: string }) => {
      await api.post('/api/service-connections/slack', { botToken, teamId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-connections'] });
    }
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'august-service-connection') {
        queryClient.invalidateQueries({ queryKey: ['service-connections'] });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [queryClient]);

  const services = serviceData && serviceData.length > 0 ? serviceData : FALLBACK_SERVICES;
  const servers = mcpData ?? [];
  const connectedServices = services.filter(s => s.connected).length;
  const running = servers.filter(s => s.status === 'running');
  const enabled = servers.filter(s => s.enabled && s.status !== 'running');
  const disabled = servers.filter(s => !s.enabled);

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Services"
        subtitle={`${connectedServices} connected · ${running.length} MCP servers running · ${servers.length} total MCP servers`}
      />

      <div>
        <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold mb-3 px-1">Service Connections</h3>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {(servicesLoading || mcpLoading) && services.length === 0 ? Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-44 rounded-lg border bg-muted/30 animate-pulse" />
          )) : services.map(service => (
            <ServiceConnectionCard
              key={service.name}
              service={service}
              onAuth={() => googleAuth.mutate(service.name === 'google' ? service.account : undefined)}
              onDisconnect={() => disconnect.mutate(service.name)}
              onConnectGithub={(token) => connectGithub.mutate({ token })}
              onConnectSlack={(botToken, teamId) => connectSlack.mutate({ botToken, teamId })}
              isBusy={googleAuth.isPending || disconnect.isPending || connectGithub.isPending || connectSlack.isPending}
            />
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold mb-3 px-1">MCP Servers</h3>
        {servers.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No MCP servers configured.</p>
        ) : (
          <>
            {running.length > 0 && (
              <div>
                <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold mb-2 px-1">Running</h4>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {running.map(s => <ServerCard key={s.name} server={s} />)}
                </div>
              </div>
            )}

            {enabled.length > 0 && (
              <div>
                <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold mb-2 px-1">Enabled</h4>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {enabled.map(s => <ServerCard key={s.name} server={s} />)}
                </div>
              </div>
            )}

            {disabled.length > 0 && (
              <div>
                <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold mb-2 px-1">Disabled</h4>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {disabled.map(s => <ServerCard key={s.name} server={s} />)}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ServiceConnectionCard({
  service,
  onAuth,
  onDisconnect,
  onConnectGithub,
  onConnectSlack,
  isBusy
}: {
  service: ServiceConnection;
  onAuth: () => void;
  onDisconnect: () => void;
  onConnectGithub: (token: string) => void;
  onConnectSlack: (botToken: string, teamId: string) => void;
  isBusy: boolean;
}) {
  const meta = getServiceStatusMeta(service.status);
  const Icon = getServiceIcon(service.name);
  const StatusIcon = meta.icon;
  const [githubToken, setGithubToken] = useState('');
  const [slackToken, setSlackToken] = useState('');
  const [slackTeamId, setSlackTeamId] = useState('');
  const token = service.name === 'slack' ? slackToken : githubToken;
  const setToken = service.name === 'slack' ? setSlackToken : setGithubToken;
  const teamId = service.name === 'slack' ? slackTeamId : '';

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className={cn(
            'size-10 rounded-xl grid place-items-center text-white text-sm font-bold shrink-0',
            Icon.color
          )}>
            <Icon.icon className="size-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <CardTitle>{service.label}</CardTitle>
              <span className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                meta.tone === 'good' && 'bg-emerald-500/10 text-emerald-500',
                meta.tone === 'warn' && 'bg-amber-500/10 text-amber-500',
                meta.tone === 'muted' && 'bg-muted text-muted-foreground',
              )}>
                <StatusIcon className="size-3" />
                {meta.label}
              </span>
            </div>
            <CardDescription>{service.description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {service.account && (
          <div className="rounded-lg border bg-muted/30 px-3 py-2">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Account</p>
            <p className="mt-1 text-xs font-mono truncate" title={service.account}>{service.account}</p>
          </div>
        )}

        {service.maskedToken && (
          <div className="rounded-lg border bg-muted/30 px-3 py-2">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Token</p>
            <p className="mt-1 text-xs font-mono truncate" title={service.maskedToken}>{service.maskedToken}</p>
          </div>
        )}

        {service.teamId && (
          <div className="rounded-lg border bg-muted/30 px-3 py-2">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Team</p>
            <p className="mt-1 text-xs font-mono">{service.teamId}</p>
          </div>
        )}

        {service.missingConfig && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300">
            Add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to .env, then restart August.
          </div>
        )}

        <div className="flex flex-wrap gap-1">
          {service.scopes.slice(0, 9).map(scope => (
            <span key={scope} className="inline-flex items-center rounded bg-secondary px-1.5 py-0.5 text-[9px] font-mono text-secondary-foreground">
              {scope}
            </span>
          ))}
          {service.scopes.length > 9 && <span className="text-[9px] text-muted-foreground">+{service.scopes.length - 9}</span>}
        </div>

        <div className="grid grid-cols-2 gap-2">
          {service.name === 'google' && (
            <>
              <Button type="button" variant="outline" size="sm" onClick={onAuth} disabled={isBusy || service.missingConfig}>
                <ExternalLink className="size-3.5" />
                {service.connected ? 'Re-auth' : 'Connect'}
              </Button>
              <Button type="button" variant="destructive" size="sm" onClick={onDisconnect} disabled={isBusy || !service.connected}>
                <Trash2 className="size-3.5" />
                Disconnect
              </Button>
            </>
          )}

          {service.name === 'github' && (
            <>
              {service.connected ? (
                <Button type="button" variant="destructive" size="sm" className="col-span-2" onClick={onDisconnect} disabled={isBusy}>
                  <Trash2 className="size-3.5" />
                  Disconnect
                </Button>
              ) : (
                <>
                  <Input className="h-8 text-xs font-mono" placeholder="GitHub token" value={token} onChange={e => setToken(e.target.value)} />
                  <Button type="button" size="sm" onClick={() => onConnectGithub(token)} disabled={isBusy || !token.trim()}>
                    <KeyRound className="size-3.5" />
                    Connect
                  </Button>
                </>
              )}
            </>
          )}

          {service.name === 'slack' && (
            <>
              {service.connected ? (
                <Button type="button" variant="destructive" size="sm" className="col-span-2" onClick={onDisconnect} disabled={isBusy}>
                  <Trash2 className="size-3.5" />
                  Disconnect
                </Button>
              ) : (
                <>
                  <Input className="h-8 text-xs font-mono" placeholder="xoxb token" value={token} onChange={e => setToken(e.target.value)} />
                  <Input className="h-8 text-xs font-mono" placeholder="Team ID" value={teamId} onChange={service.name === 'slack' ? e => setSlackTeamId(e.target.value) : undefined} />
                  <Button type="button" size="sm" className="col-span-2" onClick={() => onConnectSlack(token, teamId)} disabled={isBusy || !token.trim() || !teamId.trim()}>
                    <KeyRound className="size-3.5" />
                    Connect
                  </Button>
                </>
              )}
            </>
          )}
        </div>

        {service.updatedAt && (
          <p className="text-[10px] text-muted-foreground">Updated {formatTime(service.updatedAt)}</p>
        )}
      </CardContent>
    </Card>
  );
}

function ServerCard({ server }: { server: McpServer }) {
  const meta = getStatusMeta(server.status);
  const StatusIcon = meta.icon;
  const visual = SERVER_ICONS[server.name] ?? { icon: server.name[0]?.toUpperCase() ?? '?', color: 'from-slate-500 to-slate-700' };

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={cn(
            'size-9 rounded-lg bg-gradient-to-br grid place-items-center text-white text-[11px] font-bold shrink-0',
            visual.color,
          )}>
            {visual.icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold font-mono truncate">{server.name}</h3>
              <span className={cn(
                'inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded-full',
                meta.tone === 'good' && 'bg-emerald-500/10 text-emerald-500',
                meta.tone === 'bad' && 'bg-red-500/10 text-red-500',
                meta.tone === 'warn' && 'bg-amber-500/10 text-amber-500',
                meta.tone === 'muted' && 'bg-muted text-muted-foreground',
              )}>
                <StatusIcon className={cn('size-2.5', meta.tone === 'warn' && 'animate-spin')} />
                {meta.label}
              </span>
            </div>

            {server.toolCount > 0 && (
              <p className="text-[10px] text-muted-foreground mt-1 font-mono flex items-center gap-1">
                <Wrench className="size-2.5" /> {server.toolCount} tools
              </p>
            )}

            {server.error && (
              <p className="text-[10px] text-red-500/80 mt-1 truncate" title={server.error}>
                {server.error}
              </p>
            )}

            {server.tools && server.tools.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {server.tools.slice(0, 3).map(tool => (
                  <span key={tool} className="inline-flex items-center rounded bg-secondary text-secondary-foreground px-1.5 py-0.5 text-[9px] font-mono truncate max-w-[120px]">
                    {tool}
                  </span>
                ))}
                {server.tools.length > 3 && (
                  <span className="text-[9px] text-muted-foreground">+{server.tools.length - 3}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
