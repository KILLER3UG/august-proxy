import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Brain, FileText, Heart, Calendar, Layers, Database, Sparkles, BookOpen, ChevronDown, ChevronRight, Activity, AlertTriangle, Clock } from 'lucide-react';
import { cn, formatDuration } from '@/lib/utils';

interface SemanticFact {
  key: string;
  value: string;
  category: string;
  source: string;
  created: string;
  updated: string;
  ttl: string | null;
}

interface VectorEntry {
  id: string;
  topic?: string;
  summary?: string;
  timestamp?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}

interface MemoryItem {
  id: string;
  text: string;
  type: string;
  key: string;
  injection: { score: number; reason: string };
  pinned?: boolean;
  updated_at?: string;
}

interface LearningRun {
  status: 'idle' | 'learning' | 'evolved' | 'skipped' | 'failed';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  topic?: string | null;
  summary?: string | null;
  reason?: string | null;
  warning?: string | null;
  error?: string | null;
  addedFacts?: unknown[];
  deletedFacts?: unknown[];
  semanticFacts?: unknown[];
  guidelinesQueued?: unknown[];
  checkpointSaved?: boolean;
  partial?: boolean;
  fallbackReason?: string | null;
}

interface LearningStatus {
  status: LearningRun['status'];
  lastStartedAt?: string | null;
  lastEndedAt?: string | null;
  lastDurationMs?: number;
  lastReason?: string | null;
  lastError?: string | null;
  history?: LearningRun[];
}

type Tab = 'system' | 'facts' | 'vector' | 'items' | 'learning';

export function Memory() {
  const [tab, setTab] = useState<Tab>('facts');

  // System prompt
  const systemQuery = useQuery({
    queryKey: ['memory-system'],
    queryFn: async () => {
      try {
        return await api.get<{ prompt: string; length: number }>('/ui/memory/preview?profile=claude');
      } catch {
        return { prompt: '(unavailable)', length: 0 };
      }
    },
  });

  // Semantic facts (50+)
  const factsQuery = useQuery({
    queryKey: ['semantic-facts'],
    queryFn: async () => {
      try {
        const data = await api.get<{ facts: SemanticFact[]; count: number }>('/ui/semantic-memory');
        return data;
      } catch {
        return { facts: [], count: 0 };
      }
    },
    refetchInterval: 15_000,
  });

  // Vector DB entries
  const vectorQuery = useQuery({
    queryKey: ['vector-memory'],
    queryFn: async () => {
      try {
        const data = await api.get<{ entries: VectorEntry[]; count: number }>('/ui/memory/vector');
        return data;
      } catch {
        return { entries: [], count: 0 };
      }
    },
    refetchInterval: 15_000,
  });

  // Core memory items
  const itemsQuery = useQuery({
    queryKey: ['memory-items'],
    queryFn: async () => {
      try {
        const data = await api.get<{ items: MemoryItem[] }>('/ui/memory/items');
        return data.items ?? [];
      } catch {
        return [];
      }
    },
    refetchInterval: 15_000,
  });

  const learningQuery = useQuery<LearningStatus>({
    queryKey: ['memory-learning-status'],
    queryFn: async () => {
      try {
        return await api.get<LearningStatus>('/ui/memory/learning-status');
      } catch {
        return { status: 'idle', history: [] };
      }
    },
    refetchInterval: 1500,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const facts = factsQuery.data?.facts ?? [];
  const vectorEntries = vectorQuery.data?.entries ?? [];
  const items = itemsQuery.data ?? [];
  const learning = learningQuery.data ?? { status: 'idle', history: [] };
  const learningRuns = learning.history ?? [];
  const systemPrompt = systemQuery.data?.prompt;

  const tabs = [
    { id: 'facts' as Tab, label: 'Semantic Facts', count: facts.length, icon: Brain },
    { id: 'vector' as Tab, label: 'Vector DB', count: vectorEntries.length, icon: Database },
    { id: 'items' as Tab, label: 'Core Memory', count: items.length, icon: Layers },
    { id: 'learning' as Tab, label: 'Learning Log', count: learningRuns.length, icon: Activity },
    { id: 'system' as Tab, label: 'System Prompt', icon: BookOpen },
  ];

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Memory"
        subtitle={`${facts.length} semantic facts · ${vectorEntries.length} vector entries · ${items.length} core items · ${learningRuns.length} learning runs`}
      />

      {/* Tab navigation */}
      <div className="flex items-center gap-1 text-[10px] border-b border-border pb-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-1 rounded-md px-2.5 py-1.5 transition font-medium',
              tab === t.id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <t.icon className="size-3" />
            {t.label}
            {t.count !== undefined && (
              <span className={cn(
                'ml-1 rounded-full px-1.5 text-[9px] font-mono',
                tab === t.id ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground'
              )}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Semantic Facts Tab */}
      {tab === 'facts' && (
        <div className="space-y-2">
          {facts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No semantic facts stored yet. Facts are learned as you use August.</p>
          ) : (
            facts.map((fact, i) => (
              <Card key={fact.key || i}>
                <CardContent className="p-3">
                  <div className="flex items-start gap-3">
                    <Brain className="size-3.5 text-primary mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <code className="text-xs font-semibold font-mono text-foreground">{fact.key}</code>
                        <Badge variant="outline" className="text-[9px]">{fact.category}</Badge>
                        {fact.source && <span className="text-[9px] text-muted-foreground font-mono">{fact.source}</span>}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{fact.value}</p>
                      <div className="flex items-center gap-2 mt-1 text-[9px] text-muted-foreground font-mono">
                        <span>created {new Date(fact.created).toLocaleDateString()}</span>
                        {fact.ttl && <span>· expires {new Date(fact.ttl).toLocaleDateString()}</span>}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      {/* Vector DB Tab */}
      {tab === 'vector' && (
        <div className="space-y-2">
          {vectorEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Vector database is empty. Entries are indexed from conversations over time.</p>
          ) : (
            vectorEntries.map((entry) => (
              <Card key={entry.id}>
                <CardContent className="p-3">
                  <div className="flex items-start gap-3">
                    <Database className="size-3.5 text-indigo-500 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold font-mono">{entry.topic || entry.id.slice(0, 16)}</span>
                        {entry.tags && entry.tags.length > 0 && entry.tags.slice(0, 3).map(t => (
                          <span key={t} className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground">{t}</span>
                        ))}
                      </div>
                      {entry.summary && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{entry.summary}</p>
                      )}
                      {entry.timestamp && (
                        <p className="text-[9px] text-muted-foreground font-mono mt-1">{new Date(entry.timestamp).toLocaleString()}</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
          <p className="text-[10px] text-muted-foreground text-center">
            {vectorEntries.length} indexed entries · local vector DB
          </p>
        </div>
      )}

      {/* Core Memory Items Tab */}
      {tab === 'items' && (
        <div className="space-y-1.5">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No core memory items.</p>
          ) : (
            items.map((m) => (
              <Card key={m.id}>
                <CardContent className="p-3 flex items-start gap-3">
                  <div
                    className="size-1.5 rounded-full bg-primary mt-1.5 shrink-0"
                    style={{ opacity: Math.min(1, (m.injection?.score || 50) / 100) }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[9px]">{m.type}</Badge>
                      {m.pinned && <span className="text-[9px] text-amber-500 font-semibold">📌 pinned</span>}
                    </div>
                    <p className="text-sm mt-0.5">{m.text}</p>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono">
                      <span>score {m.injection?.score ?? '—'}</span>
                      {m.updated_at && <span>· updated {new Date(m.updated_at).toLocaleDateString()}</span>}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      {/* Learning Log Tab */}
      {tab === 'learning' && (
        <div className="space-y-3">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Activity className={cn('size-3.5 shrink-0', learning.status === 'learning' ? 'text-amber-500 animate-pulse' : learning.status === 'failed' ? 'text-destructive' : learning.status === 'evolved' ? 'text-emerald-500' : 'text-muted-foreground')} />
                    <h3 className="text-sm font-semibold text-foreground">Self-evolving memory engine</h3>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    status: <span className="font-mono">{learning.status}</span>
                    {learning.lastReason && <span> · {learning.lastReason}</span>}
                    {learning.lastDurationMs !== undefined && <span> · last run {formatDuration(learning.lastDurationMs)}</span>}
                  </p>
                </div>
                <Badge variant={learning.status === 'failed' ? 'destructive' : learning.status === 'evolved' ? 'success' : learning.status === 'learning' || learning.lastReason?.includes('budget') ? 'warning' : 'outline'}>
                  {learning.status}
                </Badge>
              </div>
              {(learning.lastError || learningRuns[0]?.warning) && (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
                  <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
                  <span>{learning.lastError || learningRuns[0]?.warning}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {learningRuns.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-center text-sm text-muted-foreground">No learning runs yet. Start a conversation to trigger background memory extraction.</CardContent>
            </Card>
          ) : (
            learningRuns.map((run, i) => (
              <Card key={`${run.startedAt}-${i}`}>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={run.status === 'failed' ? 'destructive' : run.status === 'evolved' ? 'success' : run.status === 'skipped' && run.reason?.includes('budget') ? 'warning' : 'outline'}>{run.status}</Badge>
                        {run.topic && <span className="text-xs font-semibold text-foreground">{run.topic}</span>}
                        {run.partial && <Badge variant="warning">partial</Badge>}
                      </div>
                      {run.summary && <p className="text-xs text-muted-foreground mt-1">{run.summary}</p>}
                      {(run.reason || run.warning || run.error) && (
                        <p className="text-[10px] text-muted-foreground mt-1 font-mono">
                          {run.reason || run.warning || run.error}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono">
                        <Clock className="size-3" />
                        <span>{new Date(run.startedAt).toLocaleString()}</span>
                        <span>·</span>
                        <span>{formatDuration(run.durationMs)}</span>
                        {run.fallbackReason && <><span>·</span><span title={run.fallbackReason}>fallback</span></>}
                      </div>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1 text-[10px]">
                      <Badge variant="outline">+{run.addedFacts?.length ?? 0} Core Facts</Badge>
                      {run.deletedFacts?.length ? <Badge variant="outline">-{run.deletedFacts.length} Core Facts</Badge> : null}
                      <Badge variant="outline">+{run.semanticFacts?.length ?? 0} Semantic</Badge>
                      <Badge variant="outline">+{run.guidelinesQueued?.length ?? 0} Rules</Badge>
                      {run.checkpointSaved && <Badge variant="outline">checkpoint</Badge>}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      {/* System Prompt Tab */}
      {tab === 'system' && (
        <Card>
          <CardContent className="p-4">
            {!systemPrompt ? (
              <p className="text-sm text-muted-foreground text-center py-4">Loading system prompt…</p>
            ) : (
              <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/80 leading-relaxed max-h-[60vh] overflow-y-auto">
                {systemPrompt}
              </pre>
            )}
            <p className="text-[10px] text-muted-foreground font-mono mt-3 text-right">
              {systemPrompt?.length ?? 0} chars
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (!ms || ms < 1000) return `${ms || 0}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rest = Math.round(sec % 60);
  return `${min}m ${rest}s`;
}
