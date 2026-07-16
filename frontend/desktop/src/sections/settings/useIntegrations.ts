/* ── useIntegrations — installed integrations + directory data ─────── */

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import {
  INTEGRATION_DIRECTORY,
  disableIntegrationId,
  enableIntegrationId,
  getCatalogEntry,
  loadEnabledIntegrationIds,
  type IntegrationCatalogEntry,
} from './integrationDirectory';

/* ── Types ──────────────────────────────────────────────────────────── */

export type ServiceName = 'google' | 'github' | 'slack';
export type ServiceStatus = 'connected' | 'disconnected' | 'needs_config';

export type GoogleFacet = 'gmail' | 'calendar' | 'drive';

export interface ServiceConnection {
  name: ServiceName;
  label: string;
  description: string;
  services: string[];
  scopes: string[];
  status: ServiceStatus;
  connected: boolean;
  /** Explicitly connected Google services (gmail/calendar/drive). */
  connectedFacets?: GoogleFacet[];
  facets?: Partial<Record<GoogleFacet, { connected?: boolean }>>;
  grantedScopes?: string[];
  account?: string;
  maskedToken?: string;
  teamId?: string;
  missingConfig?: boolean;
  hasClientId?: boolean;
  pkceReady?: boolean;
  redirectUri?: string | null;
  updatedAt?: string;
}

/** Map catalog id (google-gmail) or short name (gmail) → facet key. */
export function googleFacetFromCatalogId(id: string | undefined | null): GoogleFacet {
  const key = (id || '')
    .trim()
    .toLowerCase()
    .replace(/^google-/, '')
    .replace(/_/g, '-');
  if (key === 'calendar' || key === 'drive' || key === 'gmail') return key;
  return 'gmail';
}

export function isGoogleFacetConnected(
  conn: ServiceConnection | null | undefined,
  facet: GoogleFacet,
): boolean {
  if (!conn) return false;
  if (conn.facets?.[facet]?.connected) return true;
  if (Array.isArray(conn.connectedFacets) && conn.connectedFacets.includes(facet)) {
    return true;
  }
  // Legacy: single google flag with no facet metadata → treat all as connected.
  if (
    conn.connected &&
    (!conn.connectedFacets || conn.connectedFacets.length === 0) &&
    (!conn.facets || Object.keys(conn.facets).length === 0)
  ) {
    return true;
  }
  return false;
}

interface ServiceConnectionsResponse {
  connections: Partial<Record<ServiceName, ServiceConnection>>;
}

export interface McpServer {
  id?: string;
  name: string;
  status:
    | 'running'
    | 'stopped'
    | 'disabled'
    | 'not_started'
    | 'error'
    | 'starting'
    | 'registered';
  toolCount: number;
  enabled: boolean;
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  source?: string;
  error?: string | null;
  tools?: string[];
  catalogId?: string;
}

export type IntegrationLogoSpec =
  | { kind: 'brand'; brand: string; color: string; letter?: string; bg?: string; fg?: string }
  | { kind: 'letter'; letter: string; bg?: string; fg?: string; brand?: never; color?: never };

export interface IntegrationItem {
  id: string;
  kind: 'account-facet' | 'mcp-server';
  name: string;
  tagline: string;
  description: string;
  logo: IntegrationLogoSpec;
  verified: boolean;
  isNew: boolean;
  isCommunity: boolean;
  categories: string[];
  connected: boolean;
  status: string;
  meta: Record<string, unknown>;
  catalogId?: string;
  source:
    | {
        kind: 'account-facet';
        provider: ServiceName;
        facetId: string;
        conn: ServiceConnection | null;
        entry: IntegrationCatalogEntry;
      }
    | { kind: 'mcp'; server: McpServer; entry?: IntegrationCatalogEntry };
}

const BRAND_COLORS: Record<string, string> = {
  google: '#4285F4',
  github: '#E6EDF3',
  slack: '#E01E5A',
  filesystem: '#22C55E',
  memory: '#A855F7',
  browser: '#38BDF8',
  generic: '#94A3B8',
};

function logoForBrand(brand: string, letter: string): IntegrationLogoSpec {
  if (brand === 'google' || brand === 'github' || brand === 'slack') {
    return { kind: 'brand', brand, color: BRAND_COLORS[brand] ?? '#fff', letter };
  }
  return {
    kind: 'letter',
    letter: letter.slice(0, 2).toUpperCase(),
    bg: 'bg-muted/50',
    fg: 'text-foreground',
  };
}

/* ── Hook ───────────────────────────────────────────────────────────── */

export function useIntegrations() {
  const [enabledIds, setEnabledIds] = useState<string[]>(() => loadEnabledIntegrationIds());
  const qc = useQueryClient();

  const connsQuery = useQuery({
    queryKey: ['integrations-connections'],
    queryFn: () => api.get<ServiceConnectionsResponse>('/api/service-connections'),
    refetchInterval: 8_000,
  });

  const mcpQuery = useQuery({
    queryKey: ['integrations-mcp'],
    queryFn: async () => {
      const data = await api.get<{ servers?: Array<Record<string, unknown>> }>('/api/mcp/servers');
      const raw = data.servers ?? [];
      return raw.map((s): McpServer => {
        const name = String(s['name'] ?? s['id'] ?? 'mcp');
        const toolsRaw = Array.isArray(s['tools']) ? s['tools'] : [];
        const tools = toolsRaw.map((t) =>
          typeof t === 'string' ? t : String((t as { name?: string })?.name ?? t),
        );
        const stRaw = String(s['status'] ?? 'stopped');
        return {
          id: s['id'] != null ? String(s['id']) : undefined,
          name,
          status: stRaw as McpServer['status'],
          toolCount: Number(s['toolCount'] ?? s['tool_count'] ?? tools.length ?? 0),
          enabled: s['enabled'] !== false,
          command: s['command'] != null ? String(s['command']) : undefined,
          url: s['url'] != null ? String(s['url']) : undefined,
          args: Array.isArray(s['args']) ? (s['args'] as string[]) : undefined,
          env: (s['env'] as Record<string, string> | undefined) ?? undefined,
          error: s['error'] != null ? String(s['error']) : null,
          tools,
          source: s['source'] != null ? String(s['source']) : undefined,
          catalogId: s['catalogId'] != null ? String(s['catalogId']) : undefined,
        };
      });
    },
    refetchInterval: 8_000,
  });

  const refreshEnabled = useCallback(() => {
    setEnabledIds(loadEnabledIntegrationIds());
  }, []);

  const items: IntegrationItem[] = useMemo(() => {
    const out: IntegrationItem[] = [];
    const conns = connsQuery.data?.connections ?? {};
    const servers = mcpQuery.data ?? [];

    // Account facets the user has explicitly added
    for (const id of enabledIds) {
      const entry = getCatalogEntry(id);
      if (!entry || entry.kind !== 'account-facet' || !entry.accountProvider) continue;
      const conn = conns[entry.accountProvider] ?? null;
      const googleFacet =
        entry.accountProvider === 'google'
          ? googleFacetFromCatalogId(entry.id)
          : null;
      const connected =
        entry.accountProvider === 'google' && googleFacet
          ? isGoogleFacetConnected(conn, googleFacet)
          : Boolean(conn?.connected);
      out.push({
        id: `facet:${entry.id}`,
        kind: 'account-facet',
        name: entry.name,
        tagline: entry.tagline,
        description: entry.description,
        logo: logoForBrand(entry.brand, entry.name.slice(0, 2)),
        verified: entry.verified ?? false,
        isNew: entry.isNew ?? false,
        isCommunity: entry.isCommunity ?? false,
        categories: entry.categories,
        connected,
        status: connected ? 'connected' : (conn?.status ?? 'disconnected'),
        catalogId: entry.id,
        meta: {
          tools: entry.tools,
          developer: entry.developer,
          provider: entry.accountProvider,
          account: conn?.account,
          scopes: conn?.scopes,
          packageName: entry.packageName,
          packageVersion: entry.packageVersion,
          googleFacet,
        },
        source: {
          kind: 'account-facet',
          provider: entry.accountProvider,
          facetId: entry.id,
          conn,
          entry,
        },
      });
    }

    // MCP servers that are registered (always show installed MCP)
    for (const s of servers) {
      const catalog =
        (s.catalogId && getCatalogEntry(s.catalogId)) ||
        INTEGRATION_DIRECTORY.find(
          (e) =>
            e.kind === 'mcp-extension' &&
            (e.name.toLowerCase() === s.name.toLowerCase() ||
              e.mcp?.args?.some((a) => s.command?.includes(a) || s.args?.join(' ').includes(a))),
        );
      const brand = catalog?.brand ?? 'generic';
      out.push({
        id: `mcp:${s.id ?? s.name}`,
        kind: 'mcp-server',
        name: catalog?.name ?? s.name,
        tagline: catalog?.tagline ?? (s.command ? `${s.command}` : s.url ?? 'MCP server'),
        description:
          catalog?.description ??
          `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'} available.`,
        logo: logoForBrand(brand, (catalog?.name ?? s.name).slice(0, 2)),
        verified: catalog?.verified ?? false,
        isNew: catalog?.isNew ?? false,
        isCommunity: catalog?.isCommunity ?? false,
        categories: catalog?.categories ?? ['MCP'],
        connected: s.status === 'running',
        status: s.status,
        catalogId: catalog?.id,
        meta: {
          toolCount: s.toolCount,
          tools: s.tools?.length ? s.tools : catalog?.tools,
          command: s.command,
          args: s.args,
          env: s.env,
          error: s.error,
          enabled: s.enabled,
          developer: catalog?.developer,
          packageName: catalog?.packageName,
          packageVersion: catalog?.packageVersion,
          requirements: catalog?.requirements,
        },
        source: { kind: 'mcp', server: s, entry: catalog },
      });
    }

    return out;
  }, [connsQuery.data, mcpQuery.data, enabledIds]);

  const accounts = items.filter((i) => i.kind === 'account-facet');
  const mcpServers = items.filter((i) => i.kind === 'mcp-server');

  /** Catalog entries already added (facets enabled or MCP matching catalog). */
  const installedCatalogIds = useMemo(() => {
    const set = new Set(enabledIds);
    for (const s of mcpQuery.data ?? []) {
      if (s.catalogId) set.add(s.catalogId);
      for (const e of INTEGRATION_DIRECTORY) {
        if (e.kind !== 'mcp-extension') continue;
        if (e.name.toLowerCase() === s.name.toLowerCase()) set.add(e.id);
        if (e.packageName && (s.command?.includes(e.packageName) || s.args?.join(' ').includes(e.packageName))) {
          set.add(e.id);
        }
      }
    }
    return set;
  }, [enabledIds, mcpQuery.data]);

  const addFromCatalog = useMutation({
    mutationFn: async ({
      entry,
      envOverrides,
    }: {
      entry: IntegrationCatalogEntry;
      envOverrides?: Record<string, string>;
    }) => {
      if (entry.kind === 'account-facet') {
        enableIntegrationId(entry.id);
        return { kind: 'facet' as const, id: entry.id };
      }
      // MCP install
      if (!entry.mcp) throw new Error('This extension has no install recipe');
      const env: Record<string, string> = {
        ...(entry.mcp.env ?? {}),
        ...(envOverrides ?? {}),
      };
      // Persist OAuth / API secrets to global MCP env so native Sign in + restarts work.
      const persistKeys = Object.keys(env).filter((k) => env[k]?.trim());
      if (persistKeys.length > 0) {
        const patch: Record<string, string> = {};
        for (const k of persistKeys) patch[k] = env[k]!;
        try {
          await api.post('/api/mcp-env', { env: patch, merge: true });
        } catch {
          /* non-fatal: server env still carries secrets */
        }
      }
      const created = await api.post<{ id: string; name: string }>('/api/mcp/servers', {
        name: entry.name,
        command: entry.mcp.command,
        args: entry.mcp.args,
        env,
        transport: entry.mcp.transport ?? 'stdio',
        catalogId: entry.id,
      });
      const sid = created.id;
      if (!sid) {
        throw new Error('Server registered but no id returned — check /api/mcp/servers response');
      }
      // Start + discover tools; surface real errors (npx missing, bad package, …)
      try {
        await api.post(`/api/mcp/servers/${encodeURIComponent(sid)}/start`, {});
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Still keep the registration so user can fix env / Start later
        enableIntegrationId(entry.id);
        throw new Error(
          `Installed ${entry.name}, but start failed: ${msg}. ` +
            'Open the card and click Start after uv/uvx or Node is on PATH, or check the command/args.',
        );
      }
      enableIntegrationId(entry.id);
      // Auto-enable Google account facets when Workspace MCP is installed
      if (entry.id === 'mcp-google-workspace') {
        for (const facet of ['google-gmail', 'google-calendar', 'google-drive']) {
          enableIntegrationId(facet);
        }
      }
      return { kind: 'mcp' as const, id: sid };
    },
    onSuccess: () => {
      refreshEnabled();
      void qc.invalidateQueries({ queryKey: ['integrations-mcp'] });
      void qc.invalidateQueries({ queryKey: ['integrations-connections'] });
    },
  });

  const removeInstalled = useMutation({
    mutationFn: async (item: IntegrationItem) => {
      if (item.kind === 'account-facet' && item.catalogId) {
        disableIntegrationId(item.catalogId);
        return;
      }
      if (item.kind === 'mcp-server' && item.source.kind === 'mcp') {
        const sid = item.source.server.id;
        if (sid) {
          await api.delete(`/api/mcp/servers/${encodeURIComponent(sid)}`);
        }
        if (item.catalogId) disableIntegrationId(item.catalogId);
      }
    },
    onSuccess: () => {
      refreshEnabled();
      void qc.invalidateQueries({ queryKey: ['integrations-mcp'] });
    },
  });

  const createCustomMcp = useMutation({
    mutationFn: async (payload: {
      name: string;
      transport: 'stdio' | 'sse' | 'http';
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
      start?: boolean;
    }) => {
      const body: Record<string, unknown> = {
        name: payload.name,
        transport: payload.transport,
        env: payload.env ?? {},
      };
      if (payload.transport === 'stdio') {
        body.command = payload.command ?? '';
        body.args = payload.args ?? [];
      } else {
        body.url = payload.url ?? '';
      }
      const created = await api.post<{ id: string; name: string }>('/api/mcp/servers', body);
      const sid = created.id;
      if (!sid) {
        throw new Error('Server registered but no id returned');
      }
      if (payload.start !== false) {
        try {
          await api.post(`/api/mcp/servers/${encodeURIComponent(sid)}/start`, {});
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(
            `Registered ${payload.name}, but start failed: ${msg}. Open the card and click Start after fixing the command/URL.`,
          );
        }
      }
      return { id: sid, name: payload.name };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['integrations-mcp'] });
    },
  });

  return {
    items,
    accounts,
    mcpServers,
    directory: INTEGRATION_DIRECTORY,
    installedCatalogIds,
    isLoading: connsQuery.isLoading && mcpQuery.isLoading,
    addFromCatalog,
    removeInstalled,
    createCustomMcp,
    refreshEnabled,
    refetch: () => {
      void connsQuery.refetch();
      void mcpQuery.refetch();
      refreshEnabled();
    },
  };
}

/* ── Auth mutations (shared Google OAuth for all Google facets) ───── */

export function useConnectAccount() {
  const qc = useQueryClient();
  return useMutation<
    {
      authUrl?: string;
      message?: string;
      status?: string;
      connected?: boolean;
      needsClientId?: boolean;
      facet?: GoogleFacet;
    },
    Error,
    | { kind: 'google'; email?: string; facet?: GoogleFacet | string }
    | { kind: 'github'; token: string }
    | { kind: 'slack'; botToken: string; teamId?: string }
  >({
    mutationFn: async (vars) => {
      switch (vars.kind) {
        case 'google':
          return api.post<{
            authUrl?: string;
            message?: string;
            connected?: boolean;
            needsClientId?: boolean;
            facet?: GoogleFacet;
          }>('/api/service-connections/google/auth', {
            email: vars.email ?? '',
            facet: googleFacetFromCatalogId(vars.facet ?? 'gmail'),
          });
        case 'github':
          return api.post<{ status: string }>('/api/service-connections/github', {
            token: vars.token,
          });
        case 'slack':
          return api.post<{ status: string }>('/api/service-connections/slack', {
            botToken: vars.botToken,
            teamId: vars.teamId ?? '',
          });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['integrations-connections'] });
    },
  });
}

export function useDisconnectAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: ServiceName | { name: ServiceName; facet?: GoogleFacet | string }) => {
      const name = typeof vars === 'string' ? vars : vars.name;
      const facet =
        typeof vars === 'string'
          ? ''
          : vars.facet
            ? googleFacetFromCatalogId(vars.facet)
            : '';
      const qs = facet ? `?facet=${encodeURIComponent(facet)}` : '';
      return api.delete(`/api/service-connections/${name}${qs}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['integrations-connections'] });
    },
  });
}
