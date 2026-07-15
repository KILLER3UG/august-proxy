import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Database } from 'lucide-react';
import type { VectorEntry } from './memoryTypes';

/** Scrollable list of embedding vector entries. */
export function MemoryVectorsTab({ vectors }: { vectors: VectorEntry[] }) {
  return (
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
  );
}
