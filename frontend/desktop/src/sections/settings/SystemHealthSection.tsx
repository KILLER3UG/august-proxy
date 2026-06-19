/* ── System & Health — workspace-style chrome over Health + Connections */
/* Migrated to the new visual style: big h1, `px-8 py-6`, dark
 * `border-white/[0.06]` rounded-xl cards. Same data fetching, same
 * fields. The old `SettingsCard` / `SettingsTooltip` modal primitives
 * are replaced with plain `border-white/[0.06]` divs for visual
 * consistency with the rest of the panel. */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStore } from '@nanostores/react';
import {
  Heart,
  Server,
  Cpu,
  Clock,
  Link2,
  Copy,
  Check,
  Brain,
  Terminal,
  Wifi,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { api } from '@/api/client';
import { $gateway } from '@/store/gateway';
import { getHostAgentStatus } from '@/api/backend-ui';
import { Badge } from '@/components/ui/badge';
import { PageLoader } from '@/components/PageLoader';

interface HealthData {
  claude?: { status: string };
  codex?: { status: string };
  uptime?: number;
  memory?: { used: number; total: number };
  origin?: string;
  port?: number;
  endpoints?: {
    anthropic: { url: string; label: string; client: string };
    openai: { url: string; label: string; client: string };
    models: { url: string; label: string; client: string };
  };
  activeUpstream?: { provider: string; baseUrl: string } | null;
}

function fmtUptime(s?: number) {
  if (!s || s <= 0) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function StatCard({
  icon: Icon,
  title,
  description,
  status,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  status?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">{title}</span>
        </div>
        {status}
      </div>
      {description && (
        <p className="text-xs text-muted-foreground mb-2">{description}</p>
      )}
      <div className="text-sm">{children}</div>
    </div>
  );
}

function EndpointRow({
  url, label, hint, icon,
}: {
  url: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-muted-foreground shrink-0">{icon}</span>
          <span className="text-sm font-medium">{label}</span>
        </div>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-background px-2 py-1 text-[10px] font-mono hover:bg-accent transition shrink-0"
          title="Copy URL"
        >
          {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <code className="block mt-1.5 text-[11px] font-mono text-foreground break-all">{url}</code>
      <p className="text-[10px] text-muted-foreground mt-1">{hint}</p>
    </div>
  );
}

export function SystemHealthSection() {
  const g = useStore($gateway);
  const { data, isLoading } = useQuery({
    queryKey: ['health', 'detailed'],
    queryFn: () => api.get<HealthData>('/api/health/detailed'),
    refetchInterval: 5_000,
  });
  const { data: hostData } = useQuery({
    queryKey: ['host-agent-status'],
    queryFn: () => getHostAgentStatus(),
    refetchInterval: 5_000,
  });

  if (isLoading) return <PageLoader label="Checking health…" />;

  const port = data?.port || (g.status === 'open' ? g.port : 0) || 8085;
  const endpoints = data?.endpoints;
  const gatewayOpen = g.status === 'open';
  const hostStatus = hostData?.status || 'unknown';
  const hostConnected = hostStatus === 'connected' || hostStatus === 'open';
  const memPct = data?.memory && data.memory.total > 0
    ? Math.round((data.memory.used / data.memory.total) * 100)
    : null;

  return (
    <div className="px-8 py-6 space-y-4 h-full flex flex-col overflow-auto">
      <header className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">System &amp; Health</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The proxy gateway is running and routing requests. Everything below is live.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Heart}
          title="Gateway"
          description="The local proxy that routes every request."
          status={<Badge variant={gatewayOpen ? 'success' : 'destructive'}>{gatewayOpen ? 'open' : g.status}</Badge>}
        >
          <p className="font-mono text-xs text-muted-foreground">port {port}</p>
        </StatCard>

        <StatCard icon={Clock} title="Uptime" description="How long the gateway has been running without restarting.">
          <p className="text-2xl font-bold">{fmtUptime(data?.uptime)}</p>
        </StatCard>

        <StatCard
          icon={Server}
          title="Host Agent"
          description="The helper process that runs file & terminal actions on this machine."
          status={<Badge variant={hostConnected ? 'success' : 'secondary'}>{hostStatus}</Badge>}
        >
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {hostConnected ? <Wifi className="size-3.5 text-emerald-500" /> : <WifiOff className="size-3.5" />}
            {hostConnected ? 'Reachable and accepting commands.' : 'Not running.'}
          </div>
        </StatCard>

        <StatCard icon={Cpu} title="Memory" description="RAM used by the proxy process.">
          {data?.memory ? (
            <>
              <p className="font-mono text-xs">
                {data.memory.used} MB / {data.memory.total} MB
              </p>
              {memPct !== null && (
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className={`h-full rounded-full ${memPct > 85 ? 'bg-amber-500' : 'bg-primary'}`}
                    style={{ width: `${memPct}%` }}
                  />
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">—</p>
          )}
        </StatCard>
      </div>

      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Link2 className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Connect an app</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Point any OpenAI- or Anthropic-compatible app at this proxy. Models from every provider are available on all paths.
        </p>
        {endpoints ? (
          <div className="space-y-3">
            <EndpointRow url={endpoints.anthropic.url} label={endpoints.anthropic.label} hint="ANTHROPIC_BASE_URL — Claude Code, Anthropic SDKs." icon={<Brain className="size-3.5" />} />
            <EndpointRow url={endpoints.openai.url} label={endpoints.openai.label} hint="OPENAI_API_BASE — OpenAI SDKs, Cursor, codex CLI." icon={<Terminal className="size-3.5" />} />
            <EndpointRow url={endpoints.models.url} label={endpoints.models.label} hint="Fetch the model list. Any OpenAI-compatible client." icon={<Link2 className="size-3.5" />} />
          </div>
        ) : (
          <div className="space-y-2">
            <EndpointRow url="http://127.0.0.1:8085/v1/messages" label="Anthropic (Claude Code)" hint="Sends /v1/messages." icon={<Brain className="size-3.5" />} />
            <EndpointRow url="http://127.0.0.1:8085/v1/chat/completions" label="OpenAI Chat Completions" hint="Sends /v1/chat/completions." icon={<Terminal className="size-3.5" />} />
            <EndpointRow url="http://127.0.0.1:8085/v1/models" label="Model list" hint="Any OpenAI-compatible client." icon={<Link2 className="size-3.5" />} />
          </div>
        )}

        {data?.activeUpstream?.baseUrl && (
          <div className="mt-3 pt-2 border-t border-white/[0.06] text-[11px] text-muted-foreground font-mono">
            active upstream: {data.activeUpstream.provider} → {data.activeUpstream.baseUrl}
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <StatCard
          icon={Brain}
          title="Claude"
          description="Upstream Anthropic connectivity."
          status={<Badge variant={data?.claude?.status === 'ok' ? 'success' : 'secondary'}>{data?.claude?.status ?? 'unknown'}</Badge>}
        >
          <p className="text-xs text-muted-foreground">Anthropic API reachability.</p>
        </StatCard>
        <StatCard
          icon={Terminal}
          title="Codex"
          description="Upstream OpenAI connectivity."
          status={<Badge variant={data?.codex?.status === 'ok' ? 'success' : 'secondary'}>{data?.codex?.status ?? 'unknown'}</Badge>}
        >
          <p className="text-xs text-muted-foreground">OpenAI API reachability.</p>
        </StatCard>
      </div>

      <p className="text-[9px] text-muted-foreground font-mono">
        🔒 The base URL works over the network this app is served from. Use a real API key from Model Providers for the upstream provider.
      </p>
    </div>
  );
}
