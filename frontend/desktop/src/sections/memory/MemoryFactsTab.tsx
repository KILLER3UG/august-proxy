import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tag, Eye, EyeOff } from 'lucide-react';
import type { MemoryItem } from './memoryTypes';

/** Expandable memory facts / items list. */
export function MemoryFactsTab({
  items,
  expandedItem,
  setExpandedItem,
}: {
  items: MemoryItem[];
  expandedItem: string | null;
  setExpandedItem: (key: string | null) => void;
}) {
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
  );
}
