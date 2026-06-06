import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Brain, FileText, Heart, Calendar, Layers } from 'lucide-react';
import { mockMemory, type MemoryEntry } from '@/lib/mock';
import { formatTimeAgo, cn } from '@/lib/utils';

const ICONS: Record<MemoryEntry['type'], typeof Brain> = {
  fact: FileText,
  preference: Heart,
  event: Calendar,
  context: Layers,
};

export function Memory() {
  const { data } = useQuery({
    queryKey: ['memory'],
    queryFn: async () => {
      try { return await api.get<{ entries: MemoryEntry[] }>('/api/memory/entries'); }
      catch { return { entries: mockMemory }; }
    },
    refetchInterval: 10_000,
  });
  const entries = data?.entries ?? mockMemory;
  const grouped = entries.reduce<Record<string, MemoryEntry[]>>((acc, e) => {
    (acc[e.type] ??= []).push(e); return acc;
  }, {});

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Memory"
        subtitle={`${entries.length} entries · ${Object.keys(grouped).length} types · hybrid storage (vector + graph)`}
        actions={<span className="text-[10px] font-mono text-muted-foreground">recall: <code className="bg-muted px-1 rounded">august brain proxy</code></span>}
      />
      <div className="space-y-5">
        {(Object.keys(grouped) as MemoryEntry['type'][]).map((type) => {
          const items = grouped[type] ?? [];
          const Icon = ICONS[type];
          return (
            <section key={type}>
              <div className="flex items-center gap-2 mb-2">
                <Icon className="size-3.5 text-muted-foreground" />
                <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{type}</h3>
                <span className="text-[10px] text-muted-foreground">· {items.length}</span>
              </div>
              <div className="space-y-1.5">
                {items.map((m) => (
                  <Card key={m.id}>
                    <CardContent className="p-3 flex items-start gap-3">
                      <div
                        className="size-1.5 rounded-full bg-primary mt-1.5 shrink-0"
                        style={{ opacity: m.weight }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm">{m.content}</p>
                        <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono">
                          <span>weight {m.weight.toFixed(2)}</span>
                          <span>·</span>
                          <span>created {formatTimeAgo(m.createdAt)}</span>
                          <span>·</span>
                          <span>accessed {formatTimeAgo(m.accessedAt)}</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
