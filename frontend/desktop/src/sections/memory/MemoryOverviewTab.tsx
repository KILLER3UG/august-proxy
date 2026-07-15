import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Database, Activity, Shield, Network, Tag } from 'lucide-react';
import type {
  StoreStatus,
  VectorEntry,
  MemoryItem,
  Guideline,
  GraphStats,
  LearningStatus,
} from './memoryTypes';

type GraphCounts = NonNullable<GraphStats['stats']>['counts'];

/** Store, vector, item, graph, learning, and guideline summary cards. */
export function MemoryOverviewTab({
  store,
  vectors,
  items,
  guidelines,
  graphCounts,
  learning,
  statusTone,
}: {
  store?: StoreStatus;
  vectors: VectorEntry[];
  items: MemoryItem[];
  guidelines: Guideline[];
  graphCounts?: GraphCounts;
  learning?: LearningStatus;
  statusTone: 'warn' | 'default' | 'destructive' | 'secondary';
}) {
  return (
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
            <Badge variant={statusTone as 'default' | 'secondary' | 'destructive' | 'outline'}>{learning?.status ?? 'idle'}</Badge>
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
  );
}
