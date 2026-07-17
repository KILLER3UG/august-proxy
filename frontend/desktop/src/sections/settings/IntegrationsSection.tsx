/* ── Integrations — installed cards + directory “Add” modal ────────── */

import { useCallback, useMemo, useState } from 'react';
import {
  Search,
  Plug,
  Network,
  CircleSlash,
  Plus,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { openExternal } from '@/lib/tauri-shell';
import { IntegrationCard } from './IntegrationCard';
import { IntegrationDetail } from './IntegrationDetail';
import { IntegrationDirectoryModal } from './IntegrationDirectoryModal';
import {
  googleFacetFromCatalogId,
  useConnectAccount,
  useIntegrations,
  type IntegrationItem,
} from './useIntegrations';
import { cn } from '@/lib/utils';

type Mode = 'catalog' | 'detail';

/** Shared theme-aware field styles — blend into dark settings chrome (no pure white). */
export const INTEGRATION_FIELD_CLASS =
  'rounded-lg border border-white/[0.08] bg-white/[0.06] text-foreground placeholder:text-muted-foreground ' +
  'focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30 shadow-none';

export function IntegrationsSection() {
  const [mode, setMode] = useState<Mode>('catalog');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [dirOpen, setDirOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const connectAccount = useConnectAccount();
  const {
    items,
    accounts,
    mcpServers,
    isLoading,
    installedCatalogIds,
    addFromCatalog,
    removeInstalled,
    createCustomMcp,
    refetch,
  } = useIntegrations();

  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  );

  const openDetail = useCallback((item: IntegrationItem) => {
    setSelectedId(item.id);
    setMode('detail');
  }, []);

  const handleAccountPrimary = useCallback(
    async (item: IntegrationItem) => {
      if (item.source.kind !== 'account-facet') {
        openDetail(item);
        return;
      }
      // Already connected (or non-Google) → detail for manage / wizards.
      if (item.connected || item.source.provider !== 'google') {
        openDetail(item);
        return;
      }

      setBusyId(item.id);
      try {
        const facetId =
          item.source.kind === 'account-facet'
            ? item.source.facetId
            : item.catalogId;
        const res = await connectAccount.mutateAsync({
          kind: 'google',
          facet: googleFacetFromCatalogId(facetId ?? 'gmail'),
        });
        const authUrl = res.authUrl || '';

        if (res.connected) {
          toast.success(`${item.name} is already connected`);
          refetch();
          return;
        }
        if (!authUrl) {
          // Needs Client ID paste form — only available in detail.
          openDetail(item);
          toast.message(
            res.message ||
              (res.needsClientId
                ? 'Add a Google OAuth Client ID, then Sign in.'
                : 'Open the integration to finish connecting.'),
          );
          return;
        }
        const opened = await openExternal(authUrl);
        if (!opened) {
          window.open(authUrl, 'august-google-oauth', 'width=520,height=720');
        }
        toast.message(`Complete ${item.name} sign-in in your browser`);
      } catch (e) {
        openDetail(item);
        toast.error(e instanceof Error ? e.message : 'Failed to start Google sign-in');
      } finally {
        setBusyId(null);
      }
    },
    [connectAccount, openDetail, refetch],
  );

  const handleMcpPrimary = useCallback(
    async (item: IntegrationItem) => {
      if (item.source.kind !== 'mcp') {
        openDetail(item);
        return;
      }
      const sid = item.source.server.id;
      if (!sid) {
        openDetail(item);
        return;
      }

      if (item.status === 'error') {
        setBusyId(item.id);
        try {
          await fetch(`/api/mcp/servers/${encodeURIComponent(sid)}/stop`, {
            method: 'POST',
          }).catch(() => null);
          await fetch(`/api/mcp/servers/${encodeURIComponent(sid)}/start`, {
            method: 'POST',
          });
          toast.success(`Restarted ${item.name}`);
          refetch();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Restart failed');
        } finally {
          setBusyId(null);
        }
        return;
      }

      if (
        item.status === 'disabled' ||
        item.status === 'stopped' ||
        item.status === 'not_started' ||
        item.status === 'registered'
      ) {
        setBusyId(item.id);
        try {
          await fetch(`/api/mcp/servers/${encodeURIComponent(sid)}/start`, {
            method: 'POST',
          });
          toast.success(`Started ${item.name}`);
          refetch();
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Start failed');
        } finally {
          setBusyId(null);
        }
        return;
      }

      // Manage / running / starting → open detail
      openDetail(item);
    },
    [openDetail, refetch],
  );

  const qLower = q.trim().toLowerCase();
  const filteredAccounts = useMemo(
    () =>
      !qLower
        ? accounts
        : accounts.filter(
            (a) =>
              a.name.toLowerCase().includes(qLower) ||
              a.tagline.toLowerCase().includes(qLower),
          ),
    [accounts, qLower],
  );
  const filteredMcp = useMemo(
    () =>
      !qLower
        ? mcpServers
        : mcpServers.filter(
            (s) =>
              s.name.toLowerCase().includes(qLower) ||
              s.tagline.toLowerCase().includes(qLower),
          ),
    [mcpServers, qLower],
  );

  if (mode === 'detail' && selected) {
    return (
      <IntegrationDetail
        item={selected}
        onBack={() => setMode('catalog')}
        onRemove={async () => {
          await removeInstalled.mutateAsync(selected);
          setMode('catalog');
          setSelectedId(null);
          toast.success('Removed from integrations');
        }}
      />
    );
  }

  return (
    <div className="px-8 py-6 space-y-6 h-full flex flex-col overflow-hidden">
      <Header
        connectedCount={accounts.filter((a) => a.connected).length}
        mcpRunningCount={mcpServers.filter((s) => s.connected).length}
        onAdd={() => setDirOpen(true)}
      />

      <div className="min-h-0 flex-1 overflow-auto space-y-8">
        <SearchAndFilters q={q} onQuery={setQ} />

        <Section
          title="Connected services"
          subtitle="Gmail, Calendar, Drive, GitHub, and Slack — add only the ones you need from the directory."
          icon={<Network className="size-4 text-muted-foreground" />}
          count={`${accounts.filter((a) => a.connected).length}/${accounts.length}`}
        >
          {filteredAccounts.length === 0 ? (
            <Empty
              message={
                q
                  ? 'No services match your search.'
                  : 'Nothing added yet. Click + Add to enable Gmail, Calendar, Drive, and more.'
              }
              actionLabel="Browse directory"
              onAction={() => setDirOpen(true)}
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filteredAccounts.map((a) => (
                <IntegrationCard
                  key={a.id}
                  item={a}
                  busy={busyId === a.id}
                  onOpen={openDetail}
                  onPrimaryAction={(it) => {
                    void handleAccountPrimary(it);
                  }}
                />
              ))}
            </div>
          )}
        </Section>

        <Section
          title="MCP extensions"
          subtitle="Local MCP servers that extend August with tools (filesystem, memory, fetch, …)."
          icon={<Plug className="size-4 text-muted-foreground" />}
          count={`${mcpServers.filter((s) => s.connected).length}/${mcpServers.length} running`}
        >
          {isLoading ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-[88px] animate-pulse rounded-xl border border-border/60 bg-card"
                />
              ))}
            </div>
          ) : filteredMcp.length === 0 ? (
            <Empty
              message={
                q
                  ? 'No MCP servers match your search.'
                  : 'No MCP extensions installed. Add Filesystem or others from the directory.'
              }
              actionLabel="Add extension"
              onAction={() => setDirOpen(true)}
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filteredMcp.map((s) => (
                <IntegrationCard
                  key={s.id}
                  item={s}
                  busy={busyId === s.id}
                  onOpen={openDetail}
                  onPrimaryAction={(it) => {
                    void handleMcpPrimary(it);
                  }}
                />
              ))}
            </div>
          )}
        </Section>
      </div>

      <IntegrationDirectoryModal
        open={dirOpen}
        onClose={() => setDirOpen(false)}
        installedIds={installedCatalogIds}
        busyId={
          addFromCatalog.isPending
            ? (addFromCatalog.variables?.entry?.id ?? null)
            : null
        }
        customBusy={createCustomMcp.isPending}
        onAdd={async (entry, envOverrides) => {
          await addFromCatalog.mutateAsync({ entry, envOverrides });
          toast.success(
            entry.kind === 'mcp-extension'
              ? `Installed ${entry.name}`
              : `Added ${entry.name}`,
          );
          setDirOpen(false);
        }}
        onCreateCustom={async (payload) => {
          await createCustomMcp.mutateAsync(payload);
          toast.success(`Created ${payload.name}`);
          setDirOpen(false);
        }}
      />
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────── */

function Header({
  connectedCount,
  mcpRunningCount,
  onAdd,
}: {
  connectedCount: number;
  mcpRunningCount: number;
  onAdd: () => void;
}) {
  return (
    <header className="flex items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Services and MCP extensions for August. Add only what you need — email and calendar are separate.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="font-mono text-xs">
          {connectedCount} connected
        </Badge>
        <Badge variant="outline" className="font-mono text-xs">
          {mcpRunningCount} MCP running
        </Badge>
        <Button size="sm" onClick={onAdd} data-testid="integrations-add">
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>
    </header>
  );
}

function SearchAndFilters({
  q,
  onQuery,
}: {
  q: string;
  onQuery: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative flex-1 min-w-[280px] max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={q}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search your integrations…"
          className={cn('w-full py-2 pl-9 pr-3 text-sm', INTEGRATION_FIELD_CLASS)}
        />
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  icon,
  count,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  count?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {count && (
            <span className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
              {count}
            </span>
          )}
        </div>
      </div>
      {subtitle && <p className="text-xs text-muted-foreground -mt-1">{subtitle}</p>}
      {children}
    </section>
  );
}

function Empty({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-6 text-sm text-muted-foreground">
      <CircleSlash className="size-4 shrink-0" />
      <span className="flex-1">{message}</span>
      {actionLabel && onAction && (
        <Button variant="outline" size="sm" onClick={onAction}>
          <Plus className="size-3.5" />
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

export type { IntegrationItem };
