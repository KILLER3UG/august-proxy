import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { KnowledgeGraph } from '@/components/chat/KnowledgeGraph';
import {
  Brain, Database, Sparkles, Activity, Clock, Search,
  Shield, Zap, Network, Tag, Box, Layers, Eye, EyeOff
} from 'lucide-react';
import { cn } from '@/lib/utils';

const TABS = [
  { key: 'overview', label: 'Overview', icon: Brain },
  { key: 'vectors', label: 'Vectors', icon: Database },
  { key: 'facts', label: 'Facts', icon: Tag },
  { key: 'guidelines', label: 'Guidelines', icon: Shield },
  { key: 'graph', label: 'Graph', icon: Network },
  { key: 'search', label: 'Search', icon: Search },
  { key: 'prompt', label: 'Prompt', icon: Box },
] as const;

type Tab = typeof TABS[number]['key'];

interface VectorEntry {
  id: string;
  topic: string;
  summary: string;
  timestamp?: string;
  tags?: string[];
}

interface MemoryItem {
  id?: string;
  type: string;
  key: string;
  title?: string;
  summary: string;
  status?: string;
  pinned?: boolean;
  confidence?: number;
  source?: string;
  updatedAt?: string;
  injection?: { score: number; reason: string };
}

interface Guideline {
  id: string;
  text: string;
  source: string;
  confidence?: number;
  status: string;
  count?: number;
  createdAt: string;
  lastSeenAt?: string;
  lastUsedAt?: string;
}

interface StoreStatus {
  count?: number;
  driver?: string;
  path?: string;
  available?: boolean;
}

interface GraphStats {
  stats?: {
    counts?: { entities?: number; relations?: number; observations?: number };
    entityTypes?: Record<string, number>;
    updatedAt?: string;
  };
}

interface SearchResult {
  provider: string;
  type: string;
  title: string;
  text: string;
  score: number;
  key?: string;
  quality?: { score: number; confidence: number; label: string };
}

interface BrainDiagnostics {
  error?: string;
  injectedChars?: number;
  maxChars?: number;
  compacted?: boolean;
  guidelines?: number;
  semanticFacts?: number;
  vectorEntries?: number;
}

interface LearningStatus {
  status: string;
  lastStartedAt?: string;
  lastTopic?: string;
}

export function Memory() {
  const [tab, setTab] = useState<Tab>('overview');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedItem, setExpandedItem] = useState<string | null>(null);

  const storeStatus = useQuery<StoreStatus>({
    queryKey: ['memory-store-status'],
    queryFn: () => api.get<StoreStatus>('/api/brain/status'),
    refetchInterval: 30_000,
  });

  const memoryItems = useQuery<{ items: MemoryItem[] }>({
    queryKey: ['memory-items'],
    queryFn: () => api.get<{ items: MemoryItem[] }>('/api/brain/items'),
    refetchInterval: 30_000,
  });

  const vectorData = useQuery<{ entries: VectorEntry[] }>({
    queryKey: ['memory-vector'],
    queryFn: () => api.get<{ entries: VectorEntry[] }>('/api/brain/vectors'),
    refetchInterval: 30_000,
  });

  const guidelinesData = useQuery<{ guidelines: Guideline[] }>({
    queryKey: ['brain-guidelines'],
    queryFn: () => api.get<{ guidelines: Guideline[] }>('/api/brain/guidelines'),
    refetchInterval: 60_000,
  });

  const graphData = useQuery<GraphStats>({
    queryKey: ['brain-graph'],
    queryFn: () => api.get<GraphStats>('/api/brain/graph'),
    refetchInterval: 60_000,
  });

  const brainData = useQuery<BrainDiagnostics>({
    queryKey: ['brain-diagnostics'],
    queryFn: () => api.get<BrainDiagnostics>('/api/brain/diagnostics'),
    refetchInterval: 30_000,
  });

  const learningData = useQuery<LearningStatus>({
    queryKey: ['memory-learning-status'],
    queryFn: () => api.get<LearningStatus>('/api/brain/learning'),
    refetchInterval: 15_000,
  });

  const promptData = useQuery<{ prompt: string; length?: number }>({
    queryKey: ['memory-preview'],
    queryFn: () => api.get<{ prompt: string; length?: number }>('/api/brain/prompt'),
    refetchInterval: 60_000,
  });

  const searchResults = useQuery<{ results: SearchResult[] }>({
    queryKey: ['memory-search', searchQuery],
    queryFn: () => api.get<{ results: SearchResult[] }>(`/api/brain/search?q=${encodeURIComponent(searchQuery)}`),
    enabled: tab === 'search' && searchQuery.trim().length > 0,
  });

  const store = storeStatus.data;
  const items = memoryItems.data?.items ?? [];
  const vectors = vectorData.data?.entries ?? [];
  const guidelines = guidelinesData.data?.guidelines ?? [];
  const graph = graphData.data;
  const brain = brainData.data;
  const learning = learningData.data;
  const prompt = promptData.data?.prompt;
  const graphCounts = graph?.stats?.counts;
  const graphTypes = graph?.stats?.entityTypes;

  const statusTone = learning?.status === 'learning' ? 'warn'
    : learning?.status === 'evolved' ? 'default'
    : learning?.status === 'failed' ? 'destructive'
    : 'secondary';

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Memory & Brain"
        subtitle="Self-evolving knowledge graph, guidelines, and diagnostics."
      />

      {/* Tab Navigation */}
      <div className="flex items-center gap-1 bg-muted/30 rounded-lg p-1 flex-wrap">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition',
              tab === key
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Database className="size-4 text-muted-foreground" />
                  <span className="text-xs font-medium text-muted-foreground">SQLite Store</span>
                </div>
                <p className="text-2xl font-bold">{store?.count ?? '—'}</p>
                <p className="text-[10px] text-muted-foreground font-mono mt-1">{store?.driver ?? '—'}</p>
                <Badge variant={store?.available ? 'default' : 'destructive'} className="mt-2 text-[9px]">
                  {store?.available ? 'connected' : 'unavailable'}
                </Badge>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Database className="size-4 text-info" />
                  <span className="text-xs font-medium text-muted-foreground">Vector Entries</span>
                </div>
                <p className="text-2xl font-bold">{vectors.length}</p>
                <p className="text-[10px] text-muted-foreground font-mono mt-1">embedding chunks</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Tag className="size-4 text-success" />
                  <span className="text-xs font-medium text-muted-foreground">Memory Items</span>
                </div>
                <p className="text-2xl font-bold">{items.length}</p>
                <p className="text-[10px] text-muted-foreground font-mono mt-1">facts & integrations</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Network className="size-4 text-primary" />
                  <span className="text-xs font-medium text-muted-foreground">Knowledge Graph</span>
                </div>
                <p className="text-2xl font-bold">{graphCounts?.entities ?? '—'}</p>
                <p className="text-[10px] text-muted-foreground font-mono mt-1">
                  {graphCounts?.relations ?? 0} relations · {graphCounts?.observations ?? 0} obs
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Activity className="size-4 text-muted-foreground" />
                  <span className="text-sm font-semibold">Learning Status</span>
                </div>
                <Badge variant={statusTone as any}>{learning?.status ?? 'idle'}</Badge>
                {learning?.lastTopic && (
                  <p className="text-xs text-muted-foreground mt-2">Last: {learning.lastTopic}</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Shield className="size-4 text-muted-foreground" />
                  <span className="text-sm font-semibold">Guidelines</span>
                </div>
                <p className="text-2xl font-bold">{guidelines.length}</p>
                <p className="text-[10px] text-muted-foreground font-mono mt-1">learned rules</p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Vectors Tab */}
      {tab === 'vectors' && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Database className="size-4 text-info" />
                <span className="text-sm font-semibold">Vector Database</span>
              </div>
              <Badge variant="secondary">{vectors.length} entries</Badge>
            </div>
            {vectors.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">No vector entries yet</p>
            ) : (
              <div className="space-y-2 max-h-[500px] overflow-y-auto">
                {vectors.map((v, i) => (
                  <div key={v.id || i} className="p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{v.topic}</p>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{v.summary}</p>
                      </div>
                      <span className="text-[10px] text-muted-foreground font-mono shrink-0">{v.id}</span>
                    </div>
                    {v.timestamp && (
                      <p className="text-[10px] text-muted-foreground font-mono mt-2">{new Date(v.timestamp).toLocaleString()}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Facts Tab */}
      {tab === 'facts' && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Tag className="size-4 text-success" />
                <span className="text-sm font-semibold">Memory Items</span>
              </div>
              <Badge variant="secondary">{items.length} items</Badge>
            </div>
            {items.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">No memory items yet</p>
            ) : (
              <div className="space-y-2 max-h-[500px] overflow-y-auto">
                {items.map((item, i) => {
                  const isExpanded = expandedItem === `${item.key}-${i}`;
                  return (
                    <div
                      key={`${item.key}-${i}`}
                      className="p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition cursor-pointer"
                      onClick={() => setExpandedItem(isExpanded ? null : `${item.key}-${i}`)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="text-[9px] shrink-0">{item.type}</Badge>
                            <span className="text-sm font-medium text-foreground truncate">{item.title || item.key}</span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{item.summary}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {item.pinned && <Badge variant="default" className="text-[9px]">pinned</Badge>}
                          {item.confidence && (
                            <span className="text-[10px] text-muted-foreground font-mono">{Math.round(item.confidence * 100)}%</span>
                          )}
                          {isExpanded ? <EyeOff className="size-3 text-muted-foreground" /> : <Eye className="size-3 text-muted-foreground" />}
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="mt-3 pt-3 border-t border-border/30 space-y-2 text-xs">
                          {item.status && (
                            <div className="flex items-center gap-2">
                              <span className="text-muted-foreground">Status:</span>
                              <Badge variant={item.status === 'active' ? 'default' : 'secondary'}>{item.status}</Badge>
                            </div>
                          )}
                          {item.injection && (
                            <div className="flex items-center gap-2">
                              <span className="text-muted-foreground">Injection score:</span>
                              <span className="font-mono">{item.injection.score}</span>
                              <span className="text-muted-foreground">—</span>
                              <span className="text-muted-foreground/70">{item.injection.reason}</span>
                            </div>
                          )}
                          {item.source && (
                            <div className="flex items-center gap-2">
                              <span className="text-muted-foreground">Source:</span>
                              <span className="font-mono">{item.source}</span>
                            </div>
                          )}
                          {item.updatedAt && (
                            <div className="flex items-center gap-2">
                              <span className="text-muted-foreground">Updated:</span>
                              <span className="font-mono">{new Date(item.updatedAt).toLocaleString()}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Guidelines Tab */}
      {tab === 'guidelines' && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Shield className="size-4 text-muted-foreground" />
                <span className="text-sm font-semibold">Learned Guidelines</span>
              </div>
              <Badge variant="secondary">{guidelines.length} rules</Badge>
            </div>
            {guidelines.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">No guidelines learned yet</p>
            ) : (
              <div className="space-y-1.5 max-h-[500px] overflow-y-auto">
                {guidelines.map((g, i) => (
                  <div key={g.id || i} className="flex items-start gap-2 px-3 py-2 rounded-lg hover:bg-muted/30 text-xs transition">
                    <Badge
                      variant={g.status === 'active' ? 'default' : g.status === 'pending' ? 'outline' : 'secondary'}
                      className="shrink-0 text-[9px] mt-0.5"
                    >
                      {g.status}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <p className="text-foreground/80">{g.text}</p>
                      <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                        {g.source && <span>source: {g.source}</span>}
                        {g.confidence && <span>confidence: {Math.round(g.confidence * 100)}%</span>}
                        {g.count && <span>×{g.count}</span>}
                        {g.createdAt && <span>{new Date(g.createdAt).toLocaleDateString()}</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Graph Tab */}
      {tab === 'graph' && (
        <div className="space-y-4">
          {/* Stats cards */}
          {graphCounts && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Card>
                <CardContent className="p-3 text-center">
                  <p className="text-2xl font-bold">{graphCounts.entities}</p>
                  <p className="text-[10px] text-muted-foreground">Entities</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3 text-center">
                  <p className="text-2xl font-bold">{graphCounts.relations}</p>
                  <p className="text-[10px] text-muted-foreground">Relations</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3 text-center">
                  <p className="text-2xl font-bold">{graphCounts.observations}</p>
                  <p className="text-[10px] text-muted-foreground">Observations</p>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Interactive Graph */}
          <Card className="overflow-hidden">
            <div className="h-[500px]">
              <KnowledgeGraph />
            </div>
          </Card>
        </div>
      )}

      {/* Search Tab */}
      {tab === 'search' && (
        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search memory..."
              className="w-full pl-10 pr-4 py-2.5 text-sm bg-background border border-border rounded-lg outline-none focus:ring-2 focus:ring-primary/40 transition"
              autoFocus
            />
          </div>

          {searchQuery.trim() && searchResults.data && (
            <div className="space-y-2">
              {(searchResults.data.results || []).length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">No results found</p>
              )}
              {(searchResults.data.results || []).map((r, i) => (
                <Card key={i}>
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[9px] shrink-0">{r.provider}</Badge>
                          <span className="text-xs font-medium text-foreground truncate">{r.title}</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{r.text}</p>
                      </div>
                      <Badge variant="outline" className="shrink-0 text-[9px]">{r.score}</Badge>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {!searchQuery.trim() && (
            <p className="text-sm text-muted-foreground text-center py-8">Type to search your memory</p>
          )}
        </div>
      )}

      {/* Prompt Tab */}
      {tab === 'prompt' && (
        <Card>
          <CardContent className="p-4">
            {!prompt ? (
              <p className="text-sm text-muted-foreground text-center py-4">Loading system prompt...</p>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-muted-foreground font-mono">{promptData.data?.length ?? prompt.length} chars</span>
                  <Badge variant={brain?.compacted ? 'destructive' : 'secondary'}>
                    {brain?.compacted ? 'compacted' : 'full'}
                  </Badge>
                </div>
                <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/80 leading-relaxed max-h-[60vh] overflow-y-auto bg-muted/20 rounded p-3">
                  {prompt}
                </pre>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
