/* You tab — "what August knows about you", one coherent surface.
 * Profile facts (editable), core facts, learned heuristics (with provenance
 * + suppress/re-enable feedback), friction attribution, sleep-cycle audit. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Brain,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Gauge,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { PageLoader } from '@/components/PageLoader';
import { api } from '@/api/client';
import { useLearningData } from '@/hooks/useLearningData';

interface ModelTrackRow {
  model: string;
  provider: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
  avgTokens: number;
  avgDurationMs: number;
}

interface RoutingStats {
  models: ModelTrackRow[];
  daily: Array<{ day: string; tokens: number }>;
  totalTokens: number;
}

interface ProfileFact {
  fact?: string;
  field?: string;
  updated_at?: number;
}

interface FrictionStats {
  total: number;
  sinceDays: number;
  byCategory: Record<string, number>;
  topTools?: Array<{ tool: string; count: number }>;
}

interface FrictionEvent {
  id: number;
  sessionId?: string;
  category?: string;
  detail?: string;
  toolName?: string;
  createdAt?: string;
}

interface AuditEntry {
  id: number;
  action?: string;
  targetKey?: string;
  reason?: string;
  detail?: string;
  createdAt?: string;
}

const CATEGORY_TONES: Record<string, string> = {
  provider: 'bg-rose-500/15 text-rose-500',
  harness: 'bg-amber-500/15 text-amber-500',
  model: 'bg-violet-500/15 text-violet-500',
  requirement: 'bg-sky-500/15 text-sky-500',
  tool: 'bg-orange-500/15 text-orange-500',
  external: 'bg-zinc-500/15 text-zinc-400',
  complexity: 'bg-fuchsia-500/15 text-fuchsia-500',
};

const AUDIT_TONES: Record<string, string> = {
  merge: 'bg-amber-500/15 text-amber-500',
  promote: 'bg-emerald-500/15 text-emerald-500',
  delete: 'bg-rose-500/15 text-rose-500',
  stale: 'bg-zinc-500/15 text-zinc-400',
};

function formatFacts(profile: unknown): ProfileFact[] {
  if (!profile || typeof profile !== 'object') return [];
  const p = profile as Record<string, unknown>;
  if (!Array.isArray(p.facts)) return [];
  return (p.facts as ProfileFact[]).filter((f) => f && typeof f.fact === 'string');
}

function formatDate(ts?: string | number): string {
  if (!ts) return '';
  const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface TimelineDigestEntry {
  id: number;
  timestamp?: string;
  category?: string;
  eventSummary?: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  heuristic: 'rules learned',
  memory: 'memories stored',
  review: 'reflections',
  consolidation: 'sleep cycles',
  skill_genesis: 'skills drafted',
  delta_engine: 'edit signals',
  session: 'sessions',
};

/** Weekly digest (F6): aggregate the last 7 days of timeline + friction +
 *  learning activity into a single "this week" card. Pure frontend — the
 *  data is already served by /api/brain/timeline + /api/brain/learning. */
function WeeklyDigestCard({
  data,
  stats,
}: {
  data: { heuristics: unknown[]; autoMemories: unknown[]; pendingSkills: unknown[] };
  stats?: FrictionStats;
}) {
  const { data: timeline } = useQuery<{ items: TimelineDigestEntry[] }>({
    queryKey: ['brain-timeline'],
    queryFn: async () => api.get<{ items: TimelineDigestEntry[] }>('/api/brain/timeline'),
    staleTime: 30_000,
  });

  const now = Date.now();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const byCategory = new Map<string, number>();
  let total = 0;
  for (const it of timeline?.items ?? []) {
    const t = it.timestamp ? new Date(it.timestamp).getTime() : NaN;
    if (!Number.isNaN(t) && now - t <= WEEK_MS) {
      const cat = it.category ?? 'session';
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
      total += 1;
    }
  }
  const rows = [...byCategory.entries()]
    .filter(([cat]) => CATEGORY_LABELS[cat])
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => ({ label: CATEGORY_LABELS[cat], count }));

  return (
    <Card className="p-4 space-y-2 md:col-span-2" data-testid="weekly-digest">
      <div className="flex items-center gap-2">
        <CalendarDays className="size-4 text-primary" />
        <h3 className="font-medium text-sm">This week</h3>
        <span className="text-[10px] text-muted-foreground/70 ml-auto">
          Rolling 7 days · updated as you chat
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {rows.map((r) => (
          <span
            key={r.label}
            className="text-[11px] px-2 py-1 rounded-full bg-muted/60 text-muted-foreground"
          >
            <span className="font-semibold text-foreground">{r.count}</span> {r.label}
          </span>
        ))}
        {stats && stats.total > 0 ? (
          <span className="text-[11px] px-2 py-1 rounded-full bg-warning/10 text-warning">
            <span className="font-semibold">{stats.total}</span> friction events
          </span>
        ) : null}
        <span className="text-[11px] px-2 py-1 rounded-full bg-muted/60 text-muted-foreground">
          <span className="font-semibold text-foreground">{data.heuristics.length}</span> rules
          active
        </span>
        <span className="text-[11px] px-2 py-1 rounded-full bg-muted/60 text-muted-foreground">
          <span className="font-semibold text-foreground">{data.autoMemories.length}</span>{' '}
          memories held
        </span>
        <span className="text-[11px] px-2 py-1 rounded-full bg-muted/60 text-muted-foreground">
          <span className="font-semibold text-foreground">{data.pendingSkills.length}</span>{' '}
          skills awaiting review
        </span>
      </div>
      {total === 0 && (!stats || stats.total === 0) ? (
        <p className="text-[11px] text-muted-foreground">
          Quiet week so far — activity and learning will show up here.
        </p>
      ) : null}
    </Card>
  );
}

/** Model track record (D6) + daily token burn (D7) — the optimizer view. */
function ModelTrackRecordCard() {
  const { data, isFetching } = useQuery<RoutingStats>({
    queryKey: ['routing-stats'],
    queryFn: async () => api.get<RoutingStats>('/api/brain/routing/stats'),
    staleTime: 30_000,
  });

  const models = data?.models ?? [];
  const daily = data?.daily ?? [];
  const maxTokens = Math.max(1, ...daily.map((d) => d.tokens));

  return (
    <Card className="p-4 space-y-3 md:col-span-2" data-testid="model-track-record">
      <div className="flex items-center gap-2">
        <Gauge className="size-4 text-primary" />
        <h3 className="font-medium text-sm">Model track record</h3>
        <span className="text-[10px] text-muted-foreground/70 ml-auto">
          {isFetching ? 'refreshing…' : `${data?.totalTokens ?? 0} tokens tracked`}
        </span>
      </div>

      {models.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No tracked turns yet — chat, run arenas, and this table fills with
          each model's win rate, tokens, and latency.
        </p>
      ) : (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-1.5 font-medium">Model</th>
              <th className="pb-1.5 font-medium">Wins</th>
              <th className="pb-1.5 font-medium">Rate</th>
              <th className="pb-1.5 font-medium">Avg tokens</th>
              <th className="pb-1.5 font-medium">Avg latency</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.model} className="border-t border-border/50">
                <td className="py-1.5 pr-2 truncate max-w-40">
                  <span className="font-medium">{m.model}</span>
                  <span className="text-[10px] text-muted-foreground"> · {m.provider}</span>
                </td>
                <td className="py-1.5 pr-2">
                  <span className={m.winRate >= 0.66 ? 'text-success' : m.winRate >= 0.4 ? 'text-warning' : 'text-danger'}>
                    {m.wins}/{m.total}
                  </span>
                </td>
                <td className="py-1.5 pr-2">
                  <div className="flex items-center gap-1.5">
                    <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.round(m.winRate * 100)}%` }}
                      />
                    </div>
                    <span>{Math.round(m.winRate * 100)}%</span>
                  </div>
                </td>
                <td className="py-1.5 pr-2">{m.avgTokens.toLocaleString()}</td>
                <td className="py-1.5">{(m.avgDurationMs / 1000).toFixed(1)}s</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {daily.length > 1 ? (
        <div className="pt-2 border-t border-border/50">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">
            Tokens per day
          </p>
          <div className="flex items-end gap-1 h-12">
            {daily.slice(-14).map((d) => (
              <div
                key={d.day}
                className="flex-1 rounded-sm bg-primary/40 hover:bg-primary/60 transition"
                style={{ height: `${Math.max(4, (d.tokens / maxTokens) * 100)}%` }}
                title={`${d.day}: ${d.tokens.toLocaleString()} tokens`}
              />
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export function YouTab() {
  const { data, error, isFetching } = useLearningData();
  const qc = useQueryClient();
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState('');
  const [addFactDraft, setAddFactDraft] = useState('');
  const [editingRule, setEditingRule] = useState<number | null>(null);
  const [ruleDraft, setRuleDraft] = useState('');
  const [showFriction, setShowFriction] = useState(false);
  const [showAudit, setShowAudit] = useState(false);

  const invalidate = (keys: string[][]) => {
    for (const key of keys) void qc.invalidateQueries({ queryKey: key });
  };

  const { data: friction } = useQuery<{ stats: FrictionStats; recent: FrictionEvent[] }>({
    queryKey: ['brain-friction'],
    queryFn: async () => api.get<{ stats: FrictionStats; recent: FrictionEvent[] }>('/api/brain/friction'),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

  const { data: audit } = useQuery<{ entries: AuditEntry[] }>({
    queryKey: ['brain-consolidation-audit'],
    queryFn: async () => api.get<{ entries: AuditEntry[] }>('/api/brain/consolidation/audit'),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

  const saveProfile = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch('/api/brain/profile', body),
    onSuccess: () => {
      toast.success('Profile updated');
      invalidate([['brain-learning']]);
    },
    onError: (e: Error) => toast.error(e.message || 'Profile update failed'),
  });

  const patchHeuristic = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api.patch(`/api/brain/heuristics/${id}`, body),
    onSuccess: () => {
      toast.success('Heuristic updated');
      invalidate([['brain-learning']]);
    },
    onError: (e: Error) => toast.error(e.message || 'Heuristic update failed'),
  });

  const deleteHeuristic = useMutation({
    mutationFn: (id: number) => api.delete(`/api/brain/heuristics/${id}`),
    onSuccess: () => {
      toast.success('Heuristic deleted');
      invalidate([['brain-learning']]);
    },
    onError: (e: Error) => toast.error(e.message || 'Delete failed'),
  });

  if (error) {
    return <div className="p-4 text-danger">Error loading profile data: {error.message}</div>;
  }
  if (!data) {
    return <PageLoader label="Loading what August knows…" variant="card" className="py-4" />;
  }

  const facts = formatFacts(data.userProfile);
  const profile = data.userProfile as Record<string, unknown> | null;
  const summary = typeof profile?.summary === 'string' ? profile.summary : '';
  const stats = friction?.stats;
  const recent = friction?.recent ?? [];
  const auditEntries = audit?.entries ?? [];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="flex items-center justify-between gap-3 text-xs md:col-span-2">
        <span
          className={`size-2 rounded-full ${isFetching ? 'bg-success animate-pulse' : 'bg-muted-foreground'}`}
          aria-hidden
        />
        <span className="text-muted-foreground">
          Everything here is learned from your conversations — review it, correct it, or delete it.
        </span>
        <span className="text-[10px] text-muted-foreground/70">Understanding surface</span>
      </div>

      {/* Weekly digest */}
      <WeeklyDigestCard
        data={{
          heuristics: data.heuristics,
          autoMemories: data.autoMemories,
          pendingSkills: data.pendingSkills,
        }}
        stats={stats}
      />

      {/* Model track record (D6/D7) */}
      <ModelTrackRecordCard />

      {/* Profile */}
      <Card className="p-4 space-y-3 md:col-span-2">
        <div className="flex items-center gap-2">
          <User className="size-4 text-primary" />
          <h3 className="font-medium text-sm">User profile</h3>
          {!editingSummary ? (
            <button
              type="button"
              title="Edit summary"
              className="ml-auto p-1 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setSummaryDraft(summary);
                setEditingSummary(true);
              }}
            >
              <Pencil className="size-3.5" />
            </button>
          ) : null}
        </div>
        {editingSummary ? (
          <div className="space-y-2">
            <textarea
              value={summaryDraft}
              onChange={(e) => setSummaryDraft(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
              placeholder="One-line summary of who you are / how you work"
              aria-label="Profile summary"
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50"
                disabled={saveProfile.isPending}
                data-testid="you-profile-save-summary"
                onClick={() => {
                  saveProfile.mutate({ summary: summaryDraft });
                  setEditingSummary(false);
                }}
              >
                <Check className="size-3 inline mr-1" />
                Save
              </button>
              <button
                type="button"
                className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground"
                onClick={() => setEditingSummary(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : summary ? (
          <p className="text-xs text-muted-foreground whitespace-pre-wrap">{summary}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            No profile summary yet — it builds from stable facts as you chat.
          </p>
        )}
        {facts.length > 0 ? (
          <ul className="space-y-1.5">
            {facts.map((f) => (
              <li
                key={`${f.fact}`}
                className="text-xs flex items-start gap-2 p-2 rounded hover:bg-muted/30"
                data-testid={`profile-fact-${f.field ?? 'other'}`}
              >
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0 mt-0.5">
                  {f.field || 'other'}
                </span>
                <span className="flex-1 min-w-0">{f.fact}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {formatDate(f.updated_at)}
                </span>
                <button
                  type="button"
                  title="Remove fact"
                  className="p-1 text-muted-foreground hover:text-danger shrink-0"
                  data-testid={`remove-profile-fact-${f.field ?? 'other'}`}
                  onClick={() => saveProfile.mutate({ removeFact: f.fact })}
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            No profile facts yet — stable details about you land here as August notices them.
          </p>
        )}
        <div className="flex gap-2">
          <input
            value={addFactDraft}
            onChange={(e) => setAddFactDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && addFactDraft.trim()) {
                saveProfile.mutate({ addFact: addFactDraft.trim() });
                setAddFactDraft('');
              }
            }}
            className="flex-1 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
            placeholder='Add a fact about yourself, e.g. "Prefers TypeScript over JavaScript"'
            aria-label="Add profile fact"
            data-testid="you-profile-add-fact"
          />
          <button
            type="button"
            className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50 shrink-0"
            disabled={saveProfile.isPending || !addFactDraft.trim()}
            onClick={() => {
              saveProfile.mutate({ addFact: addFactDraft.trim() });
              setAddFactDraft('');
            }}
          >
            <Plus className="size-3 inline mr-1" />
            Add
          </button>
        </div>
      </Card>

      {/* Core facts */}
      {data.coreFacts ? (
        <Card className="p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Brain className="size-4 text-primary" />
            <h3 className="font-medium text-sm">Core facts</h3>
          </div>
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-sans max-h-48 overflow-y-auto">
            {typeof data.coreFacts === 'string'
              ? data.coreFacts
              : JSON.stringify(data.coreFacts, null, 2)}
          </pre>
        </Card>
      ) : null}

      {/* Heuristics with feedback */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Brain className="size-4 text-primary" />
          <h3 className="font-medium text-sm">Learned rules</h3>
          <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
            {data.heuristics.length}
          </span>
        </div>
        {data.heuristics.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No learned rules yet — corrections and repeated preferences land here.
          </p>
        ) : (
          <ul className="space-y-2 max-h-80 overflow-y-auto">
            {data.heuristics.map((h) => (
              <li
                key={h.id}
                className={`text-xs flex items-start gap-2 p-2 rounded hover:bg-muted/30 ${
                  h.suppressed ? 'opacity-50' : ''
                }`}
                data-testid={`you-heuristic-${h.id}`}
              >
                <div className="flex-1 min-w-0">
                  {editingRule === h.id ? (
                    <input
                      value={ruleDraft}
                      onChange={(e) => setRuleDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && ruleDraft.trim()) {
                          patchHeuristic.mutate({ id: h.id, body: { rule: ruleDraft.trim() } });
                          setEditingRule(null);
                        }
                        if (e.key === 'Escape') setEditingRule(null);
                      }}
                      className="w-full rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
                      aria-label="Edit heuristic rule"
                      autoFocus
                    />
                  ) : (
                    <p>{h.rule}</p>
                  )}
                  <span className="text-[10px] text-muted-foreground">
                    <span>{h.source}</span>
                    {' · '}
                    <span>{h.category}</span>
                    {typeof h.confidence === 'number' ? (
                      <>
                        {' · '}
                        <span>{Math.round(h.confidence * 100)}% confident</span>
                      </>
                    ) : null}
                    {h.suppressed ? (
                      <>
                        {' · '}
                        <span className="text-amber-500">suppressed</span>
                      </>
                    ) : null}
                    {h.sourceSessionId ? (
                      <>
                        {' · '}
                        <span className="font-mono" title={`from session ${h.sourceSessionId}`}>
                          from {h.sourceSessionId.slice(0, 12)}…
                        </span>
                      </>
                    ) : null}
                  </span>
                </div>
                <button
                  type="button"
                  title={h.suppressed ? 'Re-enable (inject in prompts again)' : 'Suppress (stop using this rule)'}
                  className="p-1 text-muted-foreground hover:text-amber-500 shrink-0"
                  data-testid={`toggle-suppress-heuristic-${h.id}`}
                  onClick={() => patchHeuristic.mutate({ id: h.id, body: { suppressed: !h.suppressed } })}
                >
                  {h.suppressed ? <RotateCcw className="size-3.5" /> : <X className="size-3.5" />}
                </button>
                <button
                  type="button"
                  title="Edit rule text"
                  className="p-1 text-muted-foreground hover:text-foreground shrink-0"
                  onClick={() => {
                    setEditingRule(h.id);
                    setRuleDraft(h.rule);
                  }}
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  title="Delete heuristic"
                  className="p-1 text-muted-foreground hover:text-danger shrink-0"
                  onClick={() => deleteHeuristic.mutate(h.id)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Friction */}
      <Card className="p-4 space-y-3 md:col-span-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-primary" />
            <h3 className="font-medium text-sm">What's going wrong</h3>
            {stats && stats.total > 0 ? (
              <span className="text-[10px] text-warning bg-warning/10 px-2 py-0.5 rounded-full">
                {stats.total} friction events in {stats.sinceDays}d
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="p-1 text-muted-foreground hover:text-foreground"
            onClick={() => setShowFriction((v) => !v)}
            aria-expanded={showFriction}
          >
            {showFriction ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        </div>
        {!stats || stats.total === 0 ? (
          <p className="text-xs text-muted-foreground">
            No friction recorded — tool errors and retries land here so patterns become visible.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {Object.entries(stats.byCategory).map(([cat, count]) => (
                <span
                  key={cat}
                  className={`text-[11px] px-2 py-0.5 rounded-full ${CATEGORY_TONES[cat] ?? 'bg-muted text-muted-foreground'}`}
                >
                  {cat} · {count}
                </span>
              ))}
            </div>
            {showFriction ? (
              <ul className="space-y-1.5 max-h-56 overflow-y-auto">
                {recent.map((ev) => (
                  <li key={ev.id} className="text-xs flex items-start gap-2 p-1.5 rounded hover:bg-muted/30">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${CATEGORY_TONES[ev.category ?? ''] ?? 'bg-muted text-muted-foreground'}`}>
                      {ev.category ?? 'other'}
                    </span>
                    <span className="flex-1 min-w-0 text-muted-foreground">
                      {ev.detail || (ev.toolName ? `Tool: ${ev.toolName}` : '(no detail)')}
                    </span>
                    {ev.toolName ? (
                      <span className="text-[10px] font-mono text-muted-foreground shrink-0">{ev.toolName}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </Card>

      {/* Sleep-cycle audit */}
      <Card className="p-4 space-y-3 md:col-span-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="size-4 text-primary" />
            <h3 className="font-medium text-sm">Sleep-cycle audit trail</h3>
            <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
              {auditEntries.length}
            </span>
          </div>
          <button
            type="button"
            className="p-1 text-muted-foreground hover:text-foreground"
            onClick={() => setShowAudit((v) => !v)}
            aria-expanded={showAudit}
          >
            {showAudit ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        </div>
        {auditEntries.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No consolidation actions yet — merges, promotions, and deletions appear here.
          </p>
        ) : (
          <ul className={`space-y-1.5 overflow-y-auto ${showAudit ? 'max-h-72' : 'max-h-24'}`}>
            {auditEntries.map((e) => (
              <li key={e.id} className="text-xs flex items-start gap-2 p-1.5 rounded hover:bg-muted/30">
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${AUDIT_TONES[e.action ?? ''] ?? 'bg-muted text-muted-foreground'}`}>
                  {e.action ?? 'action'}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground shrink-0 max-w-40 truncate">
                  {e.targetKey}
                </span>
                <span className="flex-1 min-w-0 text-muted-foreground">{e.detail || e.reason || ''}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">{formatDate(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
