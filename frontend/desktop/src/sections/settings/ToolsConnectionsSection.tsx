/* ── Tools & Connections — deeply consolidated section ─────────────── */
/* Replaces the 3 old top-level sections (MCP & Skills, Connections,
 * host-agent summary inside Connections) with one section that:
 *   • fetches /api/service-connections + /ui/host-agent/status once via
 *     useToolsConnections — Connections.tsx and Services.tsx no longer
 *     poll the same endpoint independently for read-only views
 *   • renders Overview / Servers / Accounts as subtabs using the
 *     workspace-style chrome (big h1, WorkspaceTabs, dark rounded cards)
 *   • keeps the existing <Mcp /> (a 1200-line CRUD UI) as the Servers
 *     subtab — we deliberately preserve it rather than rewrite the full
 *     edit experience in this pass
 *   • ships a modern Accounts subtab that replaces Connections.tsx's
 *     read-only cards with a dark-themed version that reads the same
 *     shared data */

import { useState } from 'react';
import {
  Plug,
  Network,
  LayoutGrid,
  Server,
  Wifi,
  WifiOff,
  Github,
  Mail,
  MessageCircle,
  type LucideIcon,
} from 'lucide-react';
import { WorkspaceTabs } from '@/components/workspace/WorkspaceTabs';
import { Badge } from '@/components/ui/badge';
import { StatusPill } from '@/components/StatusPill';
import { Mcp } from '@/sections/mcp/Mcp';
import { formatTimeAgo, cn } from '@/lib/utils';
import {
  useToolsConnections,
  type ServiceConnection,
  type ServiceName,
} from './useToolsConnections';

/* ── Subtab definitions ─────────────────────────────────────────────── */

const TABS: { key: 'overview' | 'servers' | 'accounts'; label: string; icon: LucideIcon }[] = [
  { key: 'overview', label: 'Overview',  icon: LayoutGrid },
  { key: 'servers',  label: 'Servers',   icon: Plug },
  { key: 'accounts', label: 'Accounts',  icon: Network },
];

/* ── Top-level section ──────────────────────────────────────────────── */

export function ToolsConnectionsSection() {
  const [tab, setTab] = useState<string>('overview');
  const data = useToolsConnections();

  return (
    <div className="px-8 py-6 space-y-4 h-full flex flex-col overflow-hidden">
      <header className="shrink-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Tools &amp; Connections</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          MCP servers, skills, and connected accounts (Google, GitHub, Slack) in one place.
        </p>
      </header>

      <div className="shrink-0">
        <WorkspaceTabs value={tab} onChange={setTab} items={TABS} label="Tools views" />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'overview' && <OverviewTab data={data} onJump={setTab} />}
        {tab === 'servers'  && <Mcp />}
        {tab === 'accounts' && <AccountsTab data={data} />}
      </div>
    </div>
  );
}

/* ── Overview subtab — the deduplication payoff ─────────────────────── */

function OverviewTab({
  data,
  onJump,
}: {
  data: ReturnType<typeof useToolsConnections>;
  onJump: (tab: string) => void;
}) {
  const allConnected = data.totalCount > 0 && data.connectedCount === data.totalCount;

  return (
    <div className="space-y-4">
      {/* Status row */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="flex items-center gap-2">
              <Server className="size-4 text-muted-foreground" />
              <span className="text-sm font-semibold">Host agent</span>
            </div>
            <StatusPill tone={data.hostConnected ? 'good' : 'muted'} label={data.hostStatus} />
          </div>
          <p className="text-xs text-muted-foreground mb-2">
            The helper process that runs file &amp; terminal actions on this machine.
          </p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {data.hostConnected ? <Wifi className="size-3.5 text-emerald-500" /> : <WifiOff className="size-3.5" />}
            {data.hostConnected ? 'Reachable and accepting commands.' : 'Not running.'}
          </div>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="flex items-center gap-2">
              <Network className="size-4 text-muted-foreground" />
              <span className="text-sm font-semibold">Connected accounts</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={allConnected ? 'success' : data.connectedCount > 0 ? 'secondary' : 'destructive'}
                className="font-mono"
              >
                {data.connectedCount}/{data.totalCount}
              </Badge>
              <button
                onClick={() => onJump('accounts')}
                className="text-[11px] font-medium text-primary hover:underline"
              >
                Manage →
              </button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mb-2">
            Google, GitHub, and Slack — sign in once and reuse across sessions.
          </p>
          <p className="text-xs text-muted-foreground">
            {allConnected
              ? 'All services connected.'
              : data.connectedCount === 0
                ? 'No accounts connected yet.'
                : `${data.totalCount - data.connectedCount} still need sign-in.`}
          </p>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-4">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="flex items-center gap-2">
              <Plug className="size-4 text-muted-foreground" />
              <span className="text-sm font-semibold">MCP &amp; Skills</span>
            </div>
            <button
              onClick={() => onJump('servers')}
              className="text-[11px] font-medium text-primary hover:underline"
            >
              Configure →
            </button>
          </div>
          <p className="text-xs text-muted-foreground mb-2">
            Local servers and skills that extend the proxy's capabilities.
          </p>
          <p className="text-xs text-muted-foreground">
            Edit servers, add skills, and manage global env on the Servers tab.
          </p>
        </div>
      </div>

      {/* Quick account summary */}
      {data.totalCount === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/[0.08] bg-card/40 px-6 py-12 text-center">
          <Network className="mb-3 size-10 p-1 rounded-full bg-white/[0.04] text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No service connections yet</p>
          <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
            Sign in to Google, GitHub, or Slack from the Accounts tab to enable cross-app actions.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5">
          <div className="mb-3">
            <span className="text-sm font-semibold">Accounts at a glance</span>
            <p className="text-xs text-muted-foreground">One card per service. Click Accounts to manage.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {data.connections.map((c) => (
              <ServiceMiniCard key={c.name} conn={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ServiceMiniCard({ conn }: { conn: ServiceConnection }) {
  const Icon = ICON_FOR[conn.name as ServiceName] ?? Network;
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2.5 transition',
        conn.connected ? 'border-white/[0.06] bg-white/[0.02]' : 'border-dashed border-white/[0.08] bg-white/[0.02]',
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium truncate flex-1">{conn.label}</span>
        <Badge variant={conn.connected ? 'outline' : 'secondary'} className="text-[9px]">
          {conn.connected ? 'connected' : conn.status}
        </Badge>
      </div>
      {conn.connected && conn.account ? (
        <p className="mt-1 text-[11px] text-muted-foreground font-mono truncate">{conn.account}</p>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground italic">Not connected</p>
      )}
    </div>
  );
}

const ICON_FOR: Record<ServiceName, LucideIcon> = {
  google: Mail,
  github: Github,
  slack: MessageCircle,
};

/* ── Accounts subtab — modern replacement for the old Connections.tsx */

function AccountsTab({ data }: { data: ReturnType<typeof useToolsConnections> }) {
  if (data.totalCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/[0.08] bg-card/40 px-6 py-12 text-center">
        <Network className="mb-3 size-10 p-1 rounded-full bg-white/[0.04] text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">No service connections</p>
        <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
          Sign in to Google, GitHub, or Slack to enable cross-app actions like Gmail, Drive, and repo search.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Network className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Connected accounts</span>
          </div>
          <Badge variant="outline" className="font-mono">
            {data.connectedCount}/{data.totalCount} connected
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          The proxy never displays your raw tokens — only masked previews. Manage auth in the Servers tab.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {data.connections.map((c) => (
            <AccountCard key={c.name} conn={c} />
          ))}
        </div>
      </div>
      <p className="text-[9px] text-muted-foreground font-mono px-1">
        🔒 Account credentials and tokens are never displayed. Use the Servers tab to connect or disconnect.
      </p>
    </div>
  );
}

function AccountCard({ conn }: { conn: ServiceConnection }) {
  const Icon = ICON_FOR[conn.name as ServiceName] ?? Network;
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-3 transition',
        conn.connected ? 'border-white/[0.06] bg-white/[0.02]' : 'border-dashed border-white/[0.08] bg-white/[0.02]',
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-semibold truncate flex-1">{conn.label}</span>
        <Badge variant={conn.connected ? 'success' : 'secondary'} className="text-[9px]">
          {conn.connected ? 'connected' : 'disconnected'}
        </Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{conn.description}</p>

      {conn.connected ? (
        <div className="mt-2 space-y-1.5 text-[11px] font-mono">
          {conn.account && (
            <p className="truncate">
              <span className="text-muted-foreground/70">account</span>{' '}
              <span className="text-foreground">{conn.account}</span>
            </p>
          )}
          {conn.scopes && conn.scopes.length > 0 && (
            <p className="truncate">
              <span className="text-muted-foreground/70">scopes</span>{' '}
              <span className="text-foreground">{conn.scopes.length}</span>
            </p>
          )}
          {conn.updatedAt && (
            <p className="text-muted-foreground/70">
              updated {formatTimeAgo(conn.updatedAt)}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground italic">
          Sign in from the Servers tab to enable this service.
        </p>
      )}
    </div>
  );
}
