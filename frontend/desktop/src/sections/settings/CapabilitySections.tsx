/* ── Subagents / Plugins / Browser Use settings sections ─────────────── */
/* The registry entries existed but fell through to SettingsStub ("not
 * built yet"). Each panel now wires to the real backend surfaces:
 *  - Subagents   → /api/subagents/config (delegation limits) + /active roster
 *  - Plugins     → MCP servers + skills rosters
 *  - Browser Use → live browser/web tool roster (/api/browser/registered-tools)
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  ExternalLink,
  Globe,
  Layers,
  Loader2,
  Plug,
  RefreshCw,
  Users,
} from 'lucide-react';
import { api } from '@/api/client';
import { listActive } from '@/api/subagents';
import { Button } from '@/components/ui/button';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { openExternal } from '@/lib/tauri-shell';

const PLUGINS_URL = 'https://github.com/KILLER3UG/august-proxy#readme';

/* ── shared bits ─────────────────────────────────────────────────────── */

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function NumInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, Math.round(n))));
      }}
      className="w-20 rounded-lg border border-border/60 bg-card/60 px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary/40"
    />
  );
}

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-card/60 p-5">
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        {icon}
        {title}
      </p>
      <div className="mt-2 divide-y divide-white/[0.04]">{children}</div>
    </div>
  );
}

/* ── Subagents ───────────────────────────────────────────────────────── */

interface DelegationConfig {
  maxConcurrent: number;
  maxIterations: number;
  maxDepth: number;
  worktreeIsolation: boolean;
}

export function SubagentsSection() {
  const [cfg, setCfg] = useState<DelegationConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const roster = useQuery({
    queryKey: ['subagents-active-settings'],
    queryFn: () => listActive(),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    void api
      .get<DelegationConfig>('/api/subagents/config')
      .then((d) => setCfg(d))
      .catch(() => setCfg({ maxConcurrent: 5, maxIterations: 50, maxDepth: 1, worktreeIsolation: false }));
  }, []);

  const save = async (next: DelegationConfig) => {
    setCfg(next);
    setSaving(true);
    try {
      await api.post('/api/subagents/config', next);
    } catch {
      /* keep the optimistic value; the panel refetches on next visit */
    } finally {
      setSaving(false);
    }
  };

  const patch = (p: Partial<DelegationConfig>) => {
    if (cfg) void save({ ...cfg, ...p });
  };

  return (
    <div className="px-8 py-6 max-w-2xl">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
        <Users className="size-6 text-primary" /> Subagents
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        How the model delegates work to parallel sub-agents (spawn_subagents).
      </p>

      {!cfg ? (
        <Loader2 className="mt-6 size-5 animate-spin text-muted-foreground" />
      ) : (
        <>
          <div className="mt-5">
            <Card title="Delegation limits" icon={<Bot className="size-4 shrink-0 text-primary" />}>
              <Row label="Max concurrent subagents" hint="How many may run in parallel (1–30).">
                <NumInput value={cfg.maxConcurrent} min={1} max={30} onChange={(n) => patch({ maxConcurrent: n })} />
              </Row>
              <Row label="Max iterations per subagent" hint="Tool rounds before a worker is force-stopped (5–200).">
                <NumInput value={cfg.maxIterations} min={5} max={200} onChange={(n) => patch({ maxIterations: n })} />
              </Row>
              <Row label="Max delegation depth" hint="A subagent spawning its own subagents (1–5).">
                <NumInput value={cfg.maxDepth} min={1} max={5} onChange={(n) => patch({ maxDepth: n })} />
              </Row>
              <Row
                label="Worktree isolation"
                hint="Each subagent works in its own git worktree and merges back."
              >
                <SettingsToggle
                  checked={cfg.worktreeIsolation}
                  onCheckedChange={(v) => patch({ worktreeIsolation: v })}
                  label="Worktree isolation"
                />
              </Row>
            </Card>
          </div>

          <div className="mt-4">
            <Card
              title={`Active now (${roster.data?.length ?? 0})`}
              icon={<RefreshCw className={roster.isFetching ? 'size-4 animate-spin text-primary' : 'size-4 text-primary'} />}
            >
              {(roster.data?.length ?? 0) === 0 ? (
                <p className="py-3 text-xs text-muted-foreground">No subagents running.</p>
              ) : (
                roster.data!.map((a) => (
                  <Row key={a.taskId} label={a.goal || a.agentId} hint={`${a.agentId} · ${a.status}`}>
                    <span className="text-xs text-muted-foreground">{a.status}</span>
                  </Row>
                ))
              )}
            </Card>
          </div>
          {saving && <p className="mt-2 text-[11px] text-muted-foreground">Saving…</p>}
        </>
      )}
    </div>
  );
}

/* ── Plugins ─────────────────────────────────────────────────────────── */

interface McpServerRow {
  id: string;
  name: string;
  status?: string;
  enabled?: boolean;
}

interface SkillRow {
  name: string;
  description?: string;
  source?: string;
}

export function PluginsSection() {
  const servers = useQuery({
    queryKey: ['plugins-mcp-servers'],
    queryFn: () => api.get<{ servers: McpServerRow[] }>('/api/mcp/servers'),
  });
  const skills = useQuery({
    queryKey: ['plugins-skills'],
    queryFn: () => api.get<{ skills: SkillRow[] }>('/api/skills'),
  });

  const mcpCount = servers.data?.servers?.length ?? 0;
  const skillCount = skills.data?.skills?.length ?? 0;

  return (
    <div className="px-8 py-6 max-w-2xl">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
        <Layers className="size-6 text-primary" /> Plugins
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Everything that extends the agent: MCP servers, skills, and integrations.
      </p>

      <div className="mt-5 space-y-4">
        <Card title={`MCP servers (${mcpCount})`} icon={<Plug className="size-4 shrink-0 text-primary" />}>
          {servers.isLoading ? (
            <Loader2 className="my-3 size-4 animate-spin text-muted-foreground" />
          ) : mcpCount === 0 ? (
            <p className="py-3 text-xs text-muted-foreground">
              No MCP servers configured — add one under Settings → MCP Servers.
            </p>
          ) : (
            servers.data!.servers.map((s) => (
              <Row key={s.id} label={s.name} hint={s.status || undefined}>
                <span className="text-xs text-muted-foreground">{s.status ?? (s.enabled ? 'enabled' : 'disabled')}</span>
              </Row>
            ))
          )}
          <button
            type="button"
            onClick={() => window.location.assign('/settings/tools-connections')}
            className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
          >
            Manage MCP servers <ExternalLink className="size-3" />
          </button>
        </Card>

        <Card title={`Skills (${skillCount})`} icon={<Layers className="size-4 shrink-0 text-primary" />}>
          {skills.isLoading ? (
            <Loader2 className="my-3 size-4 animate-spin text-muted-foreground" />
          ) : skillCount === 0 ? (
            <p className="py-3 text-xs text-muted-foreground">No skills installed.</p>
          ) : (
            skills.data!.skills.slice(0, 12).map((s) => (
              <Row key={s.name} label={s.name} hint={s.description?.slice(0, 90)}>
                {s.source ? <span className="text-[10px] uppercase text-muted-foreground">{s.source}</span> : null}
              </Row>
            ))
          )}
          <button
            type="button"
            onClick={() => window.location.assign('/settings/skills')}
            className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
          >
            Manage skills <ExternalLink className="size-3" />
          </button>
        </Card>

        <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-card/60 p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Plugin directory</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Browse community plugins and tool packs on GitHub.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void openExternal(PLUGINS_URL)}>
            Open <ExternalLink className="ml-1.5 size-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Browser Use ─────────────────────────────────────────────────────── */

export function BrowserUseSection() {
  // Which browser/web tools the agent is actually offered right now.
  const tools = useQuery({
    queryKey: ['browser-use-tools'],
    queryFn: () =>
      api.get<{ tools: Array<{ name: string; description?: string }> }>(
        '/api/browser/registered-tools',
      ),
  });
  const browserTools = useMemo(
    () =>
      (tools.data?.tools ?? []).filter((t) =>
        /^(browser_|web_search$|web_fetch)/.test(t.name),
      ),
    [tools.data],
  );

  return (
    <div className="px-8 py-6 max-w-2xl">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
        <Globe className="size-6 text-primary" /> Browser Use
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Browser automation, web search, and page reading tools the agent can use.
      </p>

      <div className="mt-5">
        <Card
          title={`Offered tools (${browserTools.length})`}
          icon={<RefreshCw className={tools.isFetching ? 'size-4 animate-spin text-primary' : 'size-4 text-primary'} />}
        >
          {tools.isLoading ? (
            <Loader2 className="my-3 size-4 animate-spin text-muted-foreground" />
          ) : browserTools.length === 0 ? (
            <p className="py-3 text-xs text-muted-foreground">
              No browser/web tools registered — check the backend log for registration errors.
            </p>
          ) : (
            browserTools.map((t) => (
              <Row key={t.name} label={t.name} hint={t.description?.slice(0, 110)}>
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-px text-[10px] text-emerald-400">
                  on
                </span>
              </Row>
            ))
          )}
        </Card>
      </div>

      <div className="mt-4 rounded-xl border border-white/[0.06] bg-card/60 p-4">
        <p className="text-sm font-medium text-foreground">How it works</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          browser_open / browser_get_content / browser_screenshot drive a headless browser for page
          inspection; web_search and web_fetch cover search and clean Markdown extraction. Desktop
          open-in-visible-browser lives under Computer Use.
        </p>
      </div>
    </div>
  );
}
