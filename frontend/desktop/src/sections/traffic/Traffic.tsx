import { useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { SectionHeader } from '@/components/SectionHeader';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatTimeAgo } from '@/lib/utils';
import { mockRequests, type RequestLog } from '@/lib/mock';

export function Traffic() {
  const { data } = useQuery({
    queryKey: ['requests'],
    queryFn: async () => {
      try { return await api.get<{ requests: RequestLog[] }>('/api/requests'); }
      catch { return { requests: mockRequests }; }
    },
    refetchInterval: 3_000,
  });
  const requests = data?.requests ?? mockRequests;
  const [filter, setFilter] = useState<'all' | '2xx' | '4xx' | '5xx'>('all');

  const filtered = filter === 'all' ? requests : requests.filter((r) => `${Math.floor(r.status / 100)}xx` === filter);

  const parentRef = () => {};

  // Virtualizer
  const virt = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => document.getElementById('traffic-scroll') as HTMLDivElement | null,
    estimateSize: () => 36,
    overscan: 12,
  });

  return (
    <div className="p-6 space-y-4 flex flex-col h-full">
      <SectionHeader
        title="Traffic"
        subtitle={`${requests.length} requests in the last 24h · ${requests.filter(r => r.status >= 500).length} errors`}
        actions={
          <div className="flex items-center gap-1 text-[10px]">
            {(['all', '2xx', '4xx', '5xx'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-md px-2 py-1 font-mono transition',
                  filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
                )}
              >
                {f}
              </button>
            ))}
          </div>
        }
      />

      <Card className="flex-1 flex flex-col overflow-hidden">
        <div className="grid grid-cols-[60px_60px_1fr_80px_80px_100px_80px_80px] gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border font-mono">
          <span>Status</span>
          <span>Method</span>
          <span>Path</span>
          <span className="text-right">Duration</span>
          <span>Provider</span>
          <span>Model</span>
          <span className="text-right">Tokens</span>
          <span className="text-right">Cost</span>
        </div>
        <div id="traffic-scroll" ref={parentRef} className="flex-1 overflow-auto">
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((row) => {
              const r = filtered[row.index];
              return (
                <div
                  key={r.id}
                  data-index={row.index}
                  ref={(el) => { if (el) virt.measureElement(el); }}
                  style={{ position: 'absolute', top: row.start, left: 0, right: 0 }}
                  className="grid grid-cols-[60px_60px_1fr_80px_80px_100px_80px_80px] gap-2 px-3 py-2 text-xs items-center border-b border-border/40 hover:bg-accent/30 font-mono"
                >
                  <Badge variant={r.status < 300 ? 'outline' : r.status < 500 ? 'secondary' : 'destructive'} className="w-fit">
                    {r.status}
                  </Badge>
                  <span className="text-muted-foreground">{r.method}</span>
                  <span className="truncate">{r.path}</span>
                  <span className="text-right tabular-nums">{r.durationMs}ms</span>
                  <span className="truncate">{r.provider}</span>
                  <span className="truncate text-muted-foreground">{r.model}</span>
                  <span className="text-right tabular-nums">{(r.inputTokens + r.outputTokens).toLocaleString()}</span>
                  <span className="text-right tabular-nums">${r.cost.toFixed(3)}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground font-mono flex items-center gap-3">
          <span>{filtered.length} rows</span>
          <span>·</span>
          <span>showing {virt.getVirtualItems().length} (virtualized)</span>
          <span>·</span>
          <span>last: {requests[0] ? formatTimeAgo(requests[0].timestamp) : '—'}</span>
        </div>
      </Card>
    </div>
  );
}

function cn(...args: (string | false | undefined | null)[]) {
  return args.filter(Boolean).join(' ');
}
