import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Shield, Trash2 } from 'lucide-react';
import { api } from '@/api/client';
import type { Guideline } from './memoryTypes';

/** Learned guidelines / rules list — delete via /api/memory/facts/:key. */
export function MemoryGuidelinesTab({ guidelines }: { guidelines: Guideline[] }) {
  const qc = useQueryClient();

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/memory/facts/${encodeURIComponent(id)}`),
    onSuccess: () => {
      toast.success('Guideline deleted');
      void qc.invalidateQueries({ queryKey: ['brain-guidelines'] });
      void qc.invalidateQueries({ queryKey: ['brain-diagnostics'] });
      void qc.invalidateQueries({ queryKey: ['ws-mem-brain'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Delete failed'),
  });

  return (
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
              <div
                key={g.id || i}
                className="flex items-start gap-2 px-3 py-2 rounded-lg hover:bg-muted/30 text-xs transition"
              >
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
                    {g.confidence != null && (
                      <span>confidence: {Math.round(g.confidence * 100)}%</span>
                    )}
                    {g.count != null && <span>×{g.count}</span>}
                    {g.createdAt && <span>{new Date(g.createdAt).toLocaleDateString()}</span>}
                  </div>
                </div>
                {g.id ? (
                  <button
                    type="button"
                    title="Delete guideline"
                    className="p-1 text-muted-foreground hover:text-danger shrink-0"
                    disabled={remove.isPending}
                    data-testid={`delete-guideline-${g.id}`}
                    onClick={() => {
                      if (confirm('Delete this guideline?')) remove.mutate(g.id);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
