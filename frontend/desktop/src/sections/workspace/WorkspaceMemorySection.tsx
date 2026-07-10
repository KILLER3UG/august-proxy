/* ── WorkspaceMemorySection — Memory dashboard in the workspace panel ── */
/* Shows the Memory dashboard cards (store, vectors, facts, graph,
 * learning, guidelines) using the new WorkspaceStatCard primitive.
 * Below the cards, the existing Memory component is rendered for the
 * Facts / Vectors / Graph / Search / Prompt tabs. */

import { useQuery } from '@tanstack/react-query';
import { Database, Tag, Network, Shield, Sparkles } from 'lucide-react';
import { api } from '@/api/client';
import { Memory } from '@/sections/memory/Memory';
import { WorkspaceStatCard } from '@/components/workspace/WorkspaceStatCard';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface StoreStatus {
  count?: number;
  driver?: string;
  available?: boolean;
}
interface VectorData { entries?: unknown[] }
interface MemoryItems { items?: unknown[] }
interface GraphStats { stats?: { counts?: { entities?: number; relations?: number; observations?: number } } }
interface LearningStatus { status?: string; lastTopic?: string }
interface BrainDiagnostics { guidelines?: number; semanticFacts?: number; vectorEntries?: number }

export function WorkspaceMemorySection() {
  const storeStatus = useQuery<StoreStatus>({
    queryKey: ['ws-mem-store'],
    queryFn: () => api.get<StoreStatus>('/api/brain/status'),
    refetchInterval: 30_000,
  });
  const vectorData = useQuery<VectorData>({
    queryKey: ['ws-mem-vector'],
    queryFn: () => api.get<VectorData>('/api/brain/vectors'),
    refetchInterval: 30_000,
  });
  const memoryItems = useQuery<MemoryItems>({
    queryKey: ['ws-mem-items'],
    queryFn: () => api.get<MemoryItems>('/api/brain/items'),
    refetchInterval: 30_000,
  });
  const graphData = useQuery<GraphStats>({
    queryKey: ['ws-mem-graph'],
    queryFn: () => api.get<GraphStats>('/api/brain/graph'),
    refetchInterval: 60_000,
  });
  const brainData = useQuery<BrainDiagnostics>({
    queryKey: ['ws-mem-brain'],
    queryFn: () => api.get<BrainDiagnostics>('/api/brain/diagnostics'),
    refetchInterval: 30_000,
  });
  const learningData = useQuery<LearningStatus>({
    queryKey: ['ws-mem-learning'],
    queryFn: () => api.get<LearningStatus>('/api/brain/learning'),
    refetchInterval: 15_000,
  });

  const counts = graphData.data?.stats?.counts;
  const learning = learningData.data?.status ?? 'idle';
  const learningTone =
    learning === 'learning' ? 'warning'
    : learning === 'evolved' ? 'success'
    : learning === 'failed' ? 'destructive'
    : 'secondary';

  return (
    <div className="px-8 py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Memory</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The self-evolving knowledge store, semantic facts, vector entries, and learning status.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <WorkspaceStatCard
          icon={Database}
          label="Store"
          value={storeStatus.data?.count ?? '—'}
          sub={`${storeStatus.data?.driver ?? '—'}`}
          accent="emerald"
        />
        <WorkspaceStatCard
          icon={Database}
          label="Vector entries"
          value={vectorData.data?.entries?.length ?? 0}
          sub="embedding chunks"
          accent="blue"
        />
        <WorkspaceStatCard
          icon={Tag}
          label="Memory items"
          value={memoryItems.data?.items?.length ?? 0}
          sub="facts & integrations"
          accent="emerald"
        />
        <WorkspaceStatCard
          icon={Network}
          label="Knowledge graph"
          value={counts?.entities ?? '—'}
          sub={`${counts?.relations ?? 0} relations · ${counts?.observations ?? 0} obs`}
          accent="default"
        />
        <WorkspaceStatCard
          icon={Shield}
          label="Guidelines"
          value={brainData.data?.guidelines ?? 0}
          sub="learned rules"
          accent="default"
        />
        <WorkspaceStatCard
          icon={Sparkles}
          label="Learning"
          value={<Badge variant={learningTone}>{learning}</Badge>}
          sub={learningData.data?.lastTopic ?? 'No active topic'}
          accent="amber"
        />
      </div>

      {/* Existing Memory component (Facts / Vectors / Graph / Search / Prompt) */}
      <div className={cn('rounded-xl border border-white/[0.06] bg-card/40 overflow-hidden')}>
        <Memory />
      </div>
    </div>
  );
}
