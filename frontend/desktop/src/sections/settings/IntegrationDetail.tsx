/* ── IntegrationDetail — drill-down for one installed integration ──── */

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BadgeCheck,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Plug,
  PowerOff,
  RotateCw,
  AlertCircle,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { openExternal } from '@/lib/tauri-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IntegrationLogo } from './IntegrationCard';
import {
  type IntegrationItem,
  type McpServer,
  type ServiceName,
  useConnectAccount,
  useDisconnectAccount,
} from './useIntegrations';

interface IntegrationDetailProps {
  item: IntegrationItem;
  onBack: () => void;
  onRemove?: () => void | Promise<void>;
}

export function IntegrationDetail({ item, onBack, onRemove }: IntegrationDetailProps) {
  const tools = (item.meta.tools as string[] | undefined) ?? [];
  const packageName = item.meta.packageName as string | undefined;
  const packageVersion = item.meta.packageVersion as string | undefined;
  const developer = (item.meta.developer as string | undefined) ?? 'Unknown';
  const requirements = item.meta.requirements as string | undefined;

  return (
    <div className="px-8 py-6 space-y-6 h-full flex flex-col overflow-auto">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition"
      >
        <ArrowLeft className="size-3" /> Back to integrations
      </button>

      <div className="rounded-xl border border-border/60 bg-card p-5">
        <div className="flex items-start gap-4">
          <IntegrationLogo logo={item.logo} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">{item.name}</h1>
              {item.verified && <BadgeCheck className="size-4 text-muted-foreground" />}
              {item.isNew && (
                <span className="ml-1 rounded text-[11px] font-medium text-rose-400/90">New</span>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{item.tagline}</p>
            <p className="mt-2 text-xs text-muted-foreground">Developed by {developer}</p>
          </div>
          <PrimaryAction item={item} />
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-card p-5 space-y-3">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
          {item.description}
        </p>
        {packageName && (
          <p className="text-xs text-muted-foreground">
            Package{' '}
            <span className="font-mono text-foreground/80">
              {packageName}
              {packageVersion ? ` v${packageVersion}` : ''}
            </span>
          </p>
        )}
        {item.source.kind === 'mcp' && item.source.server.error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <pre className="whitespace-pre-wrap font-mono">{item.source.server.error}</pre>
          </div>
        )}
      </div>

      {tools.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <Wrench className="size-3.5" /> Tools
            <span className="font-mono font-normal text-muted-foreground">{tools.length}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {tools.map((t) => (
              <span
                key={t}
                className="rounded-md border border-border/50 bg-muted/30 px-2 py-1 font-mono text-[11px] text-foreground/80"
              >
                {t}
              </span>
            ))}
          </div>
        </section>
      )}

      {requirements && (
        <section className="space-y-1">
          <p className="text-xs font-semibold text-foreground">Requirements</p>
          <p className="text-xs text-muted-foreground">{requirements}</p>
        </section>
      )}

      {item.categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {item.categories.map((c) => (
            <Badge key={c} variant="outline" className="text-[10px]">
              {c}
            </Badge>
          ))}
        </div>
      )}

      {item.source.kind === 'mcp' && <McpServerDetails server={item.source.server} />}

      {onRemove && (
        <div className="pt-2">
          <Button
            variant="outline"
            size="sm"
            className="border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={() => void onRemove()}
          >
            <Trash2 className="size-3.5" />
            Remove from integrations
          </Button>
        </div>
      )}
    </div>
  );
}

function PrimaryAction({ item }: { item: IntegrationItem }) {
  if (item.kind === 'account-facet') {
    return <AccountAction item={item} />;
  }
  return <McpAction item={item} />;
}

function AccountAction({ item }: { item: IntegrationItem }) {
  const provider =
    item.source.kind === 'account-facet' ? item.source.provider : null;
  const conn = item.source.kind === 'account-facet' ? item.source.conn : null;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const qc = useQueryClient();
  const connect = useConnectAccount();
  const disconnect = useDisconnectAccount();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  if (!provider) return null;

  const startBrowserOAuth = async () => {
    if (provider !== 'google') return;
    setError(null);
    setPending(true);
    try {
      const res = await connect.mutateAsync({ kind: 'google' });
      if (!res.authUrl) {
        setError(
          res.message ||
            'Google OAuth is not configured yet. Add GOOGLE_OAUTH_CLIENT_ID / SECRET.',
        );
        return;
      }
      const opened = await openExternal(res.authUrl);
      if (!opened) {
        setError('Could not open the browser. Allow popups and try again.');
        return;
      }
      setWaiting(true);
      const start = Date.now();
      pollRef.current = setInterval(async () => {
        const data = await qc
          .fetchQuery({
            queryKey: ['integrations-connections'],
            queryFn: () =>
              fetch('/api/service-connections').then((r) => r.json()) as Promise<{
                connections: Record<string, { connected: boolean }>;
              }>,
            staleTime: 0,
          })
          .catch(() => null);
        if (data?.connections?.google?.connected) {
          if (pollRef.current) clearInterval(pollRef.current);
          setWaiting(false);
          void qc.invalidateQueries({ queryKey: ['integrations-connections'] });
        } else if (Date.now() - start > 5 * 60 * 1000) {
          if (pollRef.current) clearInterval(pollRef.current);
          setWaiting(false);
          setError('Timed out waiting for Google sign-in.');
        }
      }, 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start Google sign-in');
    } finally {
      setPending(false);
    }
  };

  if (conn?.connected) {
    return (
      <div className="flex flex-col items-end gap-2">
        <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
          <CheckCircle2 className="mr-1 size-3" /> Connected
        </Badge>
        {conn.account && (
          <span className="font-mono text-[11px] text-muted-foreground">{conn.account}</span>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => disconnect.mutate(provider)}
          disabled={disconnect.isPending}
        >
          {disconnect.isPending ? <Loader2 className="size-3 animate-spin" /> : <PowerOff className="size-3" />}
          Disconnect {provider === 'google' ? 'Google' : provider}
        </Button>
        {provider === 'google' && (
          <p className="max-w-[14rem] text-right text-[10px] text-muted-foreground">
            Disconnects the shared Google account used by Gmail, Calendar, and Drive.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {provider === 'google' ? (
        <>
          <Button onClick={startBrowserOAuth} disabled={pending || waiting}>
            {pending || waiting ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ExternalLink className="size-3" />
            )}
            {waiting ? 'Waiting for sign-in…' : 'Sign in with Google'}
          </Button>
          {error && <p className="max-w-xs text-right text-[11px] text-destructive">{error}</p>}
        </>
      ) : (
        <TokenConnectForm name={provider} />
      )}
    </div>
  );
}

function TokenConnectForm({ name }: { name: ServiceName }) {
  const [value, setValue] = useState('');
  const [teamId, setTeamId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const connect = useConnectAccount();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (name === 'github') {
        await connect.mutateAsync({ kind: 'github', token: value.trim() });
      } else if (name === 'slack') {
        await connect.mutateAsync({
          kind: 'slack',
          botToken: value.trim(),
          teamId: teamId.trim(),
        });
      }
      setValue('');
      setTeamId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
    }
  };

  const placeholder =
    name === 'github' ? 'ghp_… personal access token' : 'xoxb-… bot user OAuth token';

  return (
    <form onSubmit={submit} className="w-72 space-y-2">
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-white/[0.08] bg-white/[0.06] px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30 shadow-none"
      />
      {name === 'slack' && (
        <input
          type="text"
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
          placeholder="Team ID (optional)"
          className="w-full rounded-md border border-white/[0.08] bg-white/[0.06] px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30 shadow-none"
        />
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!value.trim() || connect.isPending}>
          {connect.isPending ? <Loader2 className="size-3 animate-spin" /> : <Plug className="size-3" />}
          Connect
        </Button>
      </div>
      {error && <p className="text-right text-[11px] text-destructive">{error}</p>}
    </form>
  );
}

function McpAction({ item }: { item: IntegrationItem }) {
  const server = item.source.kind === 'mcp' ? item.source.server : null;
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (!server) return null;
  const sid = server.id ?? server.name;

  const restart = async () => {
    setBusy(true);
    try {
      await fetch(`/api/mcp/servers/${encodeURIComponent(sid)}/stop`, { method: 'POST' }).catch(
        () => null,
      );
      await fetch(`/api/mcp/servers/${encodeURIComponent(sid)}/start`, { method: 'POST' });
      void qc.invalidateQueries({ queryKey: ['integrations-mcp'] });
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    try {
      await fetch(`/api/mcp/servers/${encodeURIComponent(sid)}/start`, { method: 'POST' });
      void qc.invalidateQueries({ queryKey: ['integrations-mcp'] });
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await fetch(`/api/mcp/servers/${encodeURIComponent(sid)}/stop`, { method: 'POST' });
      void qc.invalidateQueries({ queryKey: ['integrations-mcp'] });
    } finally {
      setBusy(false);
    }
  };

  if (server.status === 'running') {
    return (
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={restart} disabled={busy}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCw className="size-3" />}
          Restart
        </Button>
        <Button variant="outline" size="sm" onClick={stop} disabled={busy}>
          <PowerOff className="size-3" /> Stop
        </Button>
      </div>
    );
  }

  return (
    <Button size="sm" onClick={start} disabled={busy}>
      {busy ? <Loader2 className="size-3 animate-spin" /> : <Plug className="size-3" />}
      Start
    </Button>
  );
}

function McpServerDetails({ server }: { server: McpServer }) {
  return (
    <section className="rounded-xl border border-border/60 bg-card p-5 space-y-2 text-xs">
      <p className="font-semibold text-foreground">Server config</p>
      <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 text-muted-foreground">
        <dt>Status</dt>
        <dd className="font-mono text-foreground/80">{server.status}</dd>
        <dt>Command</dt>
        <dd className="font-mono break-all text-foreground/80">{server.command || '—'}</dd>
        <dt>Args</dt>
        <dd className="font-mono break-all text-foreground/80">
          {server.args?.length ? server.args.join(' ') : '—'}
        </dd>
        <dt>Tools</dt>
        <dd className="font-mono text-foreground/80">{server.toolCount}</dd>
      </dl>
    </section>
  );
}
