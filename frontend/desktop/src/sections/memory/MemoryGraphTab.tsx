import { Card, CardContent } from '@/components/ui/card';
import { KnowledgeGraph } from '@/components/chat/KnowledgeGraph';
import type { GraphStats } from './memoryTypes';

/** Entity/relation/observation counts plus interactive knowledge graph. */
export function MemoryGraphTab({
  graphCounts,
}: {
  graphCounts?: NonNullable<GraphStats['stats']>['counts'];
}) {
  return (
    <div className="space-y-4">
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

      <Card className="overflow-hidden">
        <div className="h-[500px]">
          <KnowledgeGraph />
        </div>
      </Card>
    </div>
  );
}
