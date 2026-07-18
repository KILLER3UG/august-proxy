import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tag, Eye, EyeOff, Trash2 } from 'lucide-react';
import { api } from '@/api/client';
import type { MemoryItem } from './memoryTypes';

/** Expandable memory facts / items list — delete via /api/memory/kv/:key. */
export function MemoryFactsTab({
  items,
  expandedItem,
  setExpandedItem,
}: {
  items: MemoryItem[];
  expandedItem: string | null;
  setExpandedItem: (key: string | null) => void;
}) {
  const qc = useQueryClient();

  const remove = useMutation({
    mutationFn: (key: string) => api.delete(`/api/memory/kv/${encodeURIComponent(key)}`),
    onSuccess: () => {
      toast.success('Memory item deleted');
      void qc.invalidateQueries({ queryKey: ['memory-items'] });
      void qc.invalidateQueries({ queryKey: ['memory-store-status'] });
      void qc.invalidateQueries({ queryKey: ['ws-mem-items'] });
      void qc.invalidateQueries({ queryKey: ['ws-mem-store'] });
      void qc.invalidateQueries({ queryKey: ['brain-learning'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Delete failed'),
  });

  return (
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
              const rowKey = `${item.key}-${i}`;
              const isExpanded = expandedItem === rowKey;
              return (
                <div
                  key={rowKey}
                  className="p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition"
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      className="flex-1 min-w-0 text-left cursor-pointer"
                      onClick={() => setExpandedItem(isExpanded ? null : rowKey)}
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[9px] shrink-0">{item.type}</Badge>
                        <span className="text-sm font-medium text-foreground truncate">
                          {item.title || item.key}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{item.summary}</p>
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      {item.pinned && (
                        <Badge variant="default" className="text-[9px]">pinned</Badge>
                      )}
                      {item.confidence != null && (
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {Math.round(item.confidence * 100)}%
                        </span>
                      )}
                      <button
                        type="button"
                        className="p-1 text-muted-foreground hover:text-foreground"
                        title={isExpanded ? 'Collapse' : 'Expand'}
                        onClick={() => setExpandedItem(isExpanded ? null : rowKey)}
                      >
                        {isExpanded ? (
                          <EyeOff className="size-3" />
                        ) : (
                          <Eye className="size-3" />
                        )}
                      </button>
                      {item.key ? (
                        <button
                          type="button"
                          title="Delete memory item"
                          className="p-1 text-muted-foreground hover:text-danger"
                          disabled={remove.isPending}
                          data-testid={`delete-memory-${item.key}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Delete memory “${item.title || item.key}”?`)) {
                              remove.mutate(item.key);
                            }
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="mt-3 pt-3 border-t border-border/30 space-y-2 text-xs">
                      {item.status && (
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">Status:</span>
                          <Badge variant={item.status === 'active' ? 'default' : 'secondary'}>
                            {item.status}
                          </Badge>
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
                          <span className="font-mono">
                            {new Date(item.updatedAt).toLocaleString()}
                          </span>
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
  );
}
