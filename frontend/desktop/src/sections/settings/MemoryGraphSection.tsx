import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { BrainCircuit, Loader2, Network } from 'lucide-react';

interface GraphEntity {
  name: string;
  type: string;
  metadata?: Record<string, unknown>;
  updatedAt?: string;
}
interface GraphRelation {
  source: string;
  target: string;
  type: string;
}

interface GraphResponse {
  entities: GraphEntity[];
  relations?: GraphRelation[];
  observations?: unknown[];
}

export function MemoryGraphSection({ embedded }: { embedded?: boolean }) {
  const q = useQuery({
    queryKey: ['memory-graph'],
    queryFn: () => api.get<GraphResponse>('/api/brain/graph'),
    refetchInterval: 30_000,
  });
  const entities: GraphEntity[] = (q.data?.entities as GraphEntity[]) ?? [];
  const relations: GraphRelation[] = (q.data?.relations as GraphRelation[]) ?? [];

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (!entities.length) {
    return (
      <div className="rounded-xl border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
        <Network className="mx-auto mb-2 size-6 text-muted-foreground/60" />
        <p className="font-medium text-foreground/80">No graph yet</p>
        <p className="mt-1">Entities and relations appear as August learns.</p>
      </div>
    );
  }

  return (
    <div className={embedded ? 'space-y-4' : 'space-y-4 px-6 py-4'}>
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card/30">
        <div className="flex items-center justify-between border-b border-border/50 bg-muted/20 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Entities ({entities.length}) · Relations ({relations.length})
          </span>
        </div>
        <ul className="divide-y divide-border/50">
          {entities.slice(0, 60).map((e) => (
            <li key={e.name} className="flex items-start gap-3 px-3 py-2.5">
              <span className="mt-0.5 inline-flex size-6 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                {String(e.type || '·').slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">{e.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {(e.metadata as Record<string, unknown>)?.label as string | undefined
                    ?? (e.metadata as Record<string, unknown>)?.preview as string | undefined
                    ?? e.type}
                </div>
                {(() => {
                  const rels = relations.filter((r) => r.source === e.name || r.target === e.name);
                  if (!rels.length) return null;
                  return (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {rels.slice(0, 4).map((r, i) => (
                        <span key={`${r.source}-${r.target}-${i}`} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          {r.type}: {r.target === e.name ? r.source : r.target}
                        </span>
                      ))}
                      {rels.length > 4 ? (
                        <span className="text-[10px] text-muted-foreground/60">+{rels.length - 4} more</span>
                      ) : null}
                    </div>
                  );
                })()}
              </div>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-[11px] text-muted-foreground/70">
        <BrainCircuit className="mr-1 inline size-3" />
        Graph is built from recalled memories. Expanding a memory shows its relations.
      </p>
    </div>
  );
}
