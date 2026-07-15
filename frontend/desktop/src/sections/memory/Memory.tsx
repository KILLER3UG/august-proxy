import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { SectionHeader } from '@/components/SectionHeader';
import { cn } from '@/lib/utils';
import {
  TABS,
  type Tab,
  type StoreStatus,
  type MemoryItem,
  type VectorEntry,
  type Guideline,
  type GraphStats,
  type BrainDiagnostics,
  type LearningStatus,
  type SearchResult,
} from './memoryTypes';
import { MemoryOverviewTab } from './MemoryOverviewTab';
import { MemoryVectorsTab } from './MemoryVectorsTab';
import { MemoryFactsTab } from './MemoryFactsTab';
import { MemoryGuidelinesTab } from './MemoryGuidelinesTab';
import { MemoryGraphTab } from './MemoryGraphTab';
import { MemorySearchTab } from './MemorySearchTab';
import { MemoryPromptTab } from './MemoryPromptTab';

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

      {tab === 'overview' && (
        <MemoryOverviewTab
          store={store}
          vectors={vectors}
          items={items}
          guidelines={guidelines}
          graphCounts={graphCounts}
          learning={learning}
          statusTone={statusTone}
        />
      )}
      {tab === 'vectors' && <MemoryVectorsTab vectors={vectors} />}
      {tab === 'facts' && (
        <MemoryFactsTab
          items={items}
          expandedItem={expandedItem}
          setExpandedItem={setExpandedItem}
        />
      )}
      {tab === 'guidelines' && <MemoryGuidelinesTab guidelines={guidelines} />}
      {tab === 'graph' && <MemoryGraphTab graphCounts={graphCounts} />}
      {tab === 'search' && (
        <MemorySearchTab
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          results={searchResults.data?.results}
        />
      )}
      {tab === 'prompt' && (
        <MemoryPromptTab
          prompt={prompt}
          promptLength={promptData.data?.length}
          brain={brain}
        />
      )}
    </div>
  );
}
