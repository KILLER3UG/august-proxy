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
  Plus,
  RotateCcw,
  Save,
  Server,
  Trash2,
  Wrench
} from 'lucide-react';

interface McpServer {
  name: string;
  status: 'running' | 'stopped' | 'disabled' | 'not_started' | 'error' | 'starting';
  toolCount: number;
  enabled: boolean;
  command?: string;
  url?: string;
  args?: string[];
  argsText?: string;
  env?: Record<string, string>;
  envText?: string;
  headers?: Record<string, string>;
  headersText?: string;
  cwd?: string;
  timeoutMs?: number;
  source?: string;
  error?: string | null;
  tools?: string[];
}

interface McpGlobalEnvVar {
  key: string;
  value: string;
  set: boolean;
  sensitive: boolean;
  masked?: boolean;
}

interface ImportLinkResult {
  sourceUrl?: string;
  resolvedUrl?: string;
  mcpServers?: Array<{ name?: string; command?: string; enabled?: boolean }>;
  skills?: Array<{ name?: string; enabled?: boolean }>;
  plugins?: Array<{ name?: string; enabled?: boolean; mcpServerCount?: number; skillCount?: number }>;
  enabledMcpServers?: string[];
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

function scopeLabel(scope: string) {
  const labels: Record<string, string> = {
    openid: 'OpenID',
    email: 'Email',
    profile: 'Profile',
    'https://www.googleapis.com/auth/gmail.readonly': 'Gmail read',
    'https://www.googleapis.com/auth/gmail.send': 'Gmail send',
    'https://www.googleapis.com/auth/calendar': 'Calendar',
    'https://www.googleapis.com/auth/drive': 'Drive',
    'https://www.googleapis.com/auth/documents': 'Documents',
    'https://www.googleapis.com/auth/spreadsheets': 'Spreadsheets',
    'https://www.googleapis.com/auth/presentations': 'Slides',
    'https://www.googleapis.com/auth/tasks': 'Tasks',
    'https://www.googleapis.com/auth/contacts': 'Contacts'
  };

  return labels[scope] || scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '').replaceAll('.', ' ').replaceAll(/[_-]+/g, ' ');
}

function linesToArray(value: string) {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function linesToObject(value: string) {
  return Object.fromEntries(
    linesToArray(value)
      .map(line => {
        const idx = line.indexOf('=');
        if (idx === -1) return [line, ''];
        return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
      })
      .filter(([key]) => key)
  );
}

function envValue(env: Record<string, string>, key: string, fallback = '') {
  return env[key] || fallback;
}

function objectToLines(value: Record<string, string> = {}) {
  return Object.entries(value)
    .map(([key, child]) => `${key}=${child}`)
    .join('\n');
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

  const { data: globalEnvData } = useQuery({
    queryKey: ['mcp-global-env'],
    queryFn: async () => {
      const res = await api.get<{ env: McpGlobalEnvVar[] }>('/api/mcp-env');
      return res.env ?? [];
    },
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

  const saveMcpServer = useMutation({
    mutationFn: async (server: McpServer) => {
      await api.post('/ui/mcp', server);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
      queryClient.invalidateQueries({ queryKey: ['mcp-global-env'] });
    }
  });

  const restartMcpServers = useMutation({
    mutationFn: async () => {
      await api.post('/ui/mcp/restart');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    }
  });

  const saveGlobalMcpEnv = useMutation({
    mutationFn: async (envText: string) => {
      const env = Object.entries(linesToObject(envText)).map(([key, value]) => ({ key, value }));
      await api.post('/api/mcp-env', { env });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mcp-global-env'] });
      restartMcpServers.mutate();
    }
  });

  const [globalEnvText, setGlobalEnvText] = useState('');

  useEffect(() => {
    if (!globalEnvData) return;
    setGlobalEnvText(globalEnvData.map(item => `${item.key}=${item.value}`).join('\n'));
  }, [globalEnvData]);

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
      <ServicesGuide />

      <div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold px-1">Accounts & logins</h3>
            <p className="px-1 text-xs text-muted-foreground">Connect the accounts August can use through tools and MCP servers.</p>
          </div>
        </div>
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

      <GoogleWorkspaceSetupPanel
        envText={globalEnvText}
        onEnvTextChange={setGlobalEnvText}
        onSave={() => saveGlobalMcpEnv.mutate(globalEnvText)}
        onRestart={() => restartMcpServers.mutate()}
        isBusy={saveGlobalMcpEnv.isPending || restartMcpServers.isPending}
      />
      <LinkImportPanel />

      <div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold px-1">MCP tools</h3>
            <p className="px-1 text-xs text-muted-foreground">Servers that expose Gmail, Drive, search, browser, Blender, and other tools.</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => restartMcpServers.mutate()} disabled={restartMcpServers.isPending || saveMcpServer.isPending}>
            <RotateCcw className={cn('size-3.5', restartMcpServers.isPending && 'animate-spin')} />
            Restart all
          </Button>
        </div>
        {servers.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No MCP servers configured.</p>
        ) : (
          <>
            {running.length > 0 && (
              <div>
                <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold mb-2 px-1">Ready</h4>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {running.map(s => <ServerCard key={s.name} server={s} onSave={(server) => saveMcpServer.mutate(server)} isBusy={saveMcpServer.isPending} />)}
                </div>
              </div>
            )}

            {enabled.length > 0 && (
              <div>
                <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold mb-2 px-1">Needs setup</h4>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {enabled.map(s => <ServerCard key={s.name} server={s} onSave={(server) => saveMcpServer.mutate(server)} isBusy={saveMcpServer.isPending} />)}
                </div>
              </div>
            )}

            {disabled.length > 0 && (
              <div>
                <h4 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold mb-2 px-1">Turned off</h4>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {disabled.map(s => <ServerCard key={s.name} server={s} onSave={(server) => saveMcpServer.mutate(server)} isBusy={saveMcpServer.isPending} />)}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ServicesGuide() {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <div className="rounded-2xl border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="grid size-7 place-items-center rounded-full bg-primary/10 text-xs font-bold text-primary">1</span>
          Connect accounts
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Use this for accounts that need login, like Google, GitHub, or Slack.
        </p>
      </div>
      <div className="rounded-2xl border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="grid size-7 place-items-center rounded-full bg-primary/10 text-xs font-bold text-primary">2</span>
          MCP tools start here
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          MCP servers turn connected accounts and local tools into callable tools. Most servers need no extra setup.
        </p>
      </div>
      <div className="rounded-2xl border bg-card p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="grid size-7 place-items-center rounded-full bg-primary/10 text-xs font-bold text-primary">3</span>
          Only add inputs when needed
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          If a server asks for a token, API key, URL, or header, open Optional and add it as KEY=value.
        </p>
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
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Stored login</p>
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
            Google login is not available yet. Add the Google OAuth secret in Google login setup, save, restart August, then connect here.
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

function GoogleWorkspaceSetupPanel({
  envText,
  onEnvTextChange,
  onSave,
  onRestart,
  isBusy
}: {
  envText: string;
  onEnvTextChange: (value: string) => void;
  onSave: () => void;
  onRestart: () => void;
  isBusy: boolean;
}) {
  const env = linesToObject(envText);
  const clientId = envValue(env, 'GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = envValue(env, 'GOOGLE_OAUTH_CLIENT_SECRET');
  const redirectUri = envValue(env, 'GOOGLE_OAUTH_REDIRECT_URI');

  function updateEnv(key: string, value: string) {
    const next = { ...env, [key]: value };
    onEnvTextChange(objectToLines(next));
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>Google login setup</CardTitle>
            <CardDescription>Connect Google Workspace tools like Gmail, Calendar, Drive, Docs, and Sheets.</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onRestart} disabled={isBusy}>
              <RotateCcw className={cn('size-3.5', isBusy && 'animate-spin')} />
              Restart
            </Button>
            <Button type="button" size="sm" onClick={onSave} disabled={isBusy}>
              <Save className="size-3.5" />
              Save
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-xl border bg-muted/20 p-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground mb-2">Beginner steps</p>
          <ol className="list-decimal pl-4 space-y-1">
            <li>Add the Google OAuth values if August asks for them.</li>
            <li>Save this card.</li>
            <li>Restart August or click Restart.</li>
            <li>Click Connect on the Google card and sign in with your Google account.</li>
          </ol>
          <p className="mt-2">The client secret is masked. Leave masked values unchanged to preserve the existing secret.</p>
        </div>

        <div className="grid gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">Google client ID</label>
            <Input
              className="h-9 text-xs font-mono"
              placeholder="Google OAuth client ID"
              value={clientId}
              onChange={e => updateEnv('GOOGLE_OAUTH_CLIENT_ID', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Google client secret</label>
            <Input
              className="h-9 text-xs font-mono"
              type="password"
              placeholder="Google OAuth client secret"
              value={clientSecret}
              onChange={e => updateEnv('GOOGLE_OAUTH_CLIENT_SECRET', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Redirect URI</label>
            <Input
              className="h-9 text-xs font-mono"
              placeholder="https://your-domain/oauth/callback"
              value={redirectUri}
              onChange={e => updateEnv('GOOGLE_OAUTH_REDIRECT_URI', e.target.value)}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function LinkImportPanel() {
  const queryClient = useQueryClient();
  const [link, setLink] = useState('');
  const [enableMcp, setEnableMcp] = useState(true);
  const [result, setResult] = useState<ImportLinkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importLink = useMutation({
    mutationFn: async (url: string) => {
      const res = await api.post('/ui/import-link', { url, enableMcp });
      return res as ImportLinkResult;
    },
    onSuccess: data => {
      setResult(data);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    },
    onError: e => {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    }
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div>
          <CardTitle>Paste a GitHub or MCP link</CardTitle>
          <CardDescription>Paste a repo, raw file, or capability link. August will look for skills, plugins, or MCP server metadata.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            className="h-10 text-xs font-mono"
            placeholder="https://github.com/owner/repo"
            value={link}
            onChange={e => setLink(e.target.value)}
          />
          <Button type="button" size="sm" onClick={() => importLink.mutate(link.trim())} disabled={importLink.isPending || !link.trim()}>
            <Link className="size-3.5" />
            Import
          </Button>
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="rounded border-border bg-background"
            checked={enableMcp}
            onChange={e => setEnableMcp(e.target.checked)}
            disabled={importLink.isPending}
          />
          enable MCP servers found in the link
        </label>

        {error && <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-500/90">{error}</p>}
        {result && (
          <div className="rounded-xl border bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-300 space-y-2">
            <p className="font-medium">Imported successfully</p>
            {result.resolvedUrl && <p className="truncate">Source: {result.resolvedUrl}</p>}
            {result.enabledMcpServers?.length ? (
              <p>MCP servers: {result.enabledMcpServers.join(', ')}</p>
            ) : (
              <p>No MCP server was imported from this link.</p>
            )}
            {result.skills?.length ? <p>Skills: {result.skills.map(s => s.name).filter(Boolean).join(', ')}</p> : null}
            {result.plugins?.length ? <p>Plugins: {result.plugins.map(p => p.name).filter(Boolean).join(', ')}</p> : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ServerCard({
  server,
  onSave,
  isBusy
}: {
  server: McpServer;
  onSave: (server: McpServer) => void;
  isBusy: boolean;
}) {
  const meta = getStatusMeta(server.status);
  const StatusIcon = meta.icon;
  const visual = SERVER_ICONS[server.name] ?? { icon: server.name[0]?.toUpperCase() ?? '?', color: 'from-slate-500 to-slate-700' };
  const [enabled, setEnabled] = useState(server.enabled);
  const [command, setCommand] = useState(server.command || '');
  const [url, setUrl] = useState(server.url || '');
  const [argsText, setArgsText] = useState(server.argsText ?? (server.args || []).join('\n'));
  const [envText, setEnvText] = useState(server.envText ?? objectToLines(server.env));
  const [headersText, setHeadersText] = useState(server.headersText ?? objectToLines(server.headers));
  const [cwd, setCwd] = useState(server.cwd || '');
  const [timeoutMs, setTimeoutMs] = useState(String(server.timeoutMs || 15000));
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const isUrlServer = url.trim().length > 0;
  const isStdioServer = !isUrlServer;
  const hasOptionalInputs = envText.trim() || headersText.trim() || argsText.trim() || cwd.trim();
  const showAdvanced = advanced || Boolean(hasOptionalInputs);
  const showUrlInput = isUrlServer || !command || advanced || !hasOptionalInputs;
  const showCommandInput = !isUrlServer || !url || advanced || !hasOptionalInputs;
  const showArgs = isStdioServer || showAdvanced;
  const showEnv = isStdioServer || showAdvanced;
  const showHeaders = isUrlServer || showAdvanced;
  const showCwd = isStdioServer || showAdvanced;

  const setupHint = !enabled
    ? 'Turned off. Toggle on if you want August to start this MCP server.'
    : server.status === 'running'
      ? 'Ready. August can call tools from this server.'
      : 'Needs setup. Check the command, URL, env, or headers, then save to restart it.';

  function buildServerPayload(): McpServer {
    return {
      ...server,
      enabled,
      command,
      url,
      args: linesToArray(argsText),
      env: linesToObject(envText),
      headers: linesToObject(headersText),
      cwd: cwd.trim() || undefined,
      timeoutMs: Math.max(1000, Number(timeoutMs) || 15000)
    };
  }

  function handleSave() {
    setError(null);
    setSaved(false);
    try {
      onSave(buildServerPayload());
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

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

        <div className="mt-4 rounded-xl border bg-muted/20 p-3">
          <div className="flex items-start gap-2">
            <div className={cn(
              'mt-0.5 size-2 rounded-full shrink-0',
              server.status === 'running' ? 'bg-emerald-500' : server.status === 'error' ? 'bg-red-500' : 'bg-amber-500'
            )} />
            <p className="text-xs leading-relaxed text-muted-foreground">{setupHint}</p>
          </div>
        </div>

        <div className="mt-4 rounded-lg border bg-muted/20 p-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-semibold">Server setup</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {isUrlServer ? 'URL transport. Headers are only needed when the remote MCP asks for auth.' : 'Command transport. Env/args are only needed when this server needs them.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!showAdvanced && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setAdvanced(true)} disabled={isBusy}>
                  <Plus className="size-3.5" />
                  Optional setup
                </Button>
              )}
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="rounded border-border bg-background"
                  checked={enabled}
                  onChange={e => setEnabled(e.target.checked)}
                  disabled={isBusy}
                />
                enabled
              </label>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {showUrlInput && (
              <Input
                className="h-8 text-xs font-mono"
                placeholder="https://host/mcp"
                value={url}
                onChange={e => setUrl(e.target.value)}
                disabled={isBusy}
              />
            )}
            {showCommandInput && (
              <Input
                className="h-8 text-xs font-mono"
                placeholder={isUrlServer ? 'leave empty for URL MCP' : 'node / uvx / npx command'}
                value={command}
                onChange={e => setCommand(e.target.value)}
                disabled={isBusy}
              />
            )}
          </div>

          {showArgs && (
            <textarea
              className="min-h-16 w-full rounded-md border bg-background px-3 py-2 text-xs font-mono outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50"
              placeholder="args, one per line"
              value={argsText}
              onChange={e => setArgsText(e.target.value)}
              disabled={isBusy}
            />
          )}

          {showEnv && (
            <textarea
              className="min-h-16 w-full rounded-md border bg-background px-3 py-2 text-xs font-mono outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50"
              placeholder="KEY=VALUE env vars, one per line"
              value={envText}
              onChange={e => setEnvText(e.target.value)}
              disabled={isBusy}
            />
          )}

          {showHeaders && (
            <textarea
              className="min-h-16 w-full rounded-md border bg-background px-3 py-2 text-xs font-mono outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50"
              placeholder="Authorization=Bearer ... headers, one per line"
              value={headersText}
              onChange={e => setHeadersText(e.target.value)}
              disabled={isBusy}
            />
          )}

          {showCwd && (
            <Input
              className="h-8 text-xs font-mono"
              placeholder="cwd"
              value={cwd}
              onChange={e => setCwd(e.target.value)}
              disabled={isBusy}
            />
          )}

          <Input
            className="h-8 text-xs font-mono"
            type="number"
            min="1000"
            value={timeoutMs}
            onChange={e => setTimeoutMs(e.target.value)}
            disabled={isBusy}
          />

          {showAdvanced && (
            <p className="rounded-md bg-muted/50 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
              Env key-value means process variables like <span className="font-mono">BRAVE_API_KEY=abc123</span>. Header key-value means HTTP headers like <span className="font-mono">Authorization=Bearer abc123</span>. Use one per line.
            </p>
          )}

          {error && <p className="text-[10px] text-red-500/80">{error}</p>}
          {saved && <p className="text-[10px] text-emerald-600 dark:text-emerald-400">Saved. Backend restarted MCP servers.</p>}

          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] text-muted-foreground">Masked secrets stay saved when left unchanged.</p>
            <Button type="button" size="sm" onClick={handleSave} disabled={isBusy}>
              <Save className="size-3.5" />
              Save inputs
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
