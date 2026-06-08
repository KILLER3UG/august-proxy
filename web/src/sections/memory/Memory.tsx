import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Brain, FileText, Heart, Calendar, Layers, Database, Sparkles, BookOpen, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SemanticFact {
  key: string;
  value: string;
  category: string;
  source: string;
  created: string;
  updated: string;
  ttl: string | null;
}

interface VectorEntry {
  id: string;
  topic?: string;
  summary?: string;
  timestamp?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}

interface MemoryItem {
  id: string;
  text: string;
  type: string;
  key: string;
  injection: { score: number; reason: string };
  pinned?: boolean;
  updated_at?: string;
}

type Tab = 'system' | 'facts' | 'vector' | 'items';

export function Memory() {
  const [tab, setTab] = useState<Tab>('facts');

  // System prompt
  const systemQuery = useQuery({
    queryKey: ['memory-system'],
    queryFn: async () => {
      try {
        return await api.get<{ prompt: string; length: number }>('/ui/memory/preview?profile=claude');
      } catch {
        return { prompt: '(unavailable)', length: 0 };
      }
    },
  });

  // Semantic facts (50+)
  const factsQuery = useQuery({
    queryKey: ['semantic-facts'],
    queryFn: async () => {
      try {
        const data = await api.get<{ facts: SemanticFact[]; count: number }>('/ui/semantic-memory');
        return data;
      } catch {
        return { facts: [], count: 0 };
      }
    },
    refetchInterval: 15_000,
  });

  // Vector DB entries
  const vectorQuery = useQuery({
    queryKey: ['vector-memory'],
    queryFn: async () => {
      try {
        const data = await api.get<{ entries: VectorEntry[]; count: number }>('/ui/memory/vector');
        return data;
      } catch {
        return { entries: [], count: 0 };
      }
    },
    refetchInterval: 15_000,
  });

  // Core memory items
  const itemsQuery = useQuery({
    queryKey: ['memory-items'],
    queryFn: async () => {
      try {
        const data = await api.get<{ items: MemoryItem[] }>('/ui/memory/items');
        return data.items ?? [];
      } catch {
        return [];
      }
    },
    refetchInterval: 15_000,
  });

  const facts = factsQuery.data?.facts ?? [];
  const vectorEntries = vectorQuery.data?.entries ?? [];
  const items = itemsQuery.data ?? [];
  const systemPrompt = systemQuery.data?.prompt;

  const tabs = [
    { id: 'facts' as Tab, label: 'Semantic Facts', count: facts.length, icon: Brain },
    { id: 'vector' as Tab, label: 'Vector DB', count: vectorEntries.length, icon: Database },
    { id: 'items' as Tab, label: 'Core Memory', count: items.length, icon: Layers },
    { id: 'system' as Tab, label: 'System Prompt', icon: BookOpen },
  ];

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Memory"
        subtitle={`${facts.length} semantic facts · ${vectorEntries.length} vector entries · ${items.length} core items`}
      />

      {/* Tab navigation */}
      <div className="flex items-center gap-1 text-[10px] border-b border-border pb-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-1 rounded-md px-2.5 py-1.5 transition font-medium',
              tab === t.id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <t.icon className="size-3" />
            {t.label}
            {t.count !== undefined && (
              <span className={cn(
                'ml-1 rounded-full px-1.5 text-[9px] font-mono',
                tab === t.id ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground'
              )}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Semantic Facts Tab */}
      {tab === 'facts' && (
        <div className="space-y-2">
          {facts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No semantic facts stored yet. Facts are learned as you use August.</p>
          ) : (
            facts.map((fact, i) => (
              <Card key={fact.key || i}>
                <CardContent className="p-3">
                  <div className="flex items-start gap-3">
                    <Brain className="size-3.5 text-primary mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <code className="text-xs font-semibold font-mono text-foreground">{fact.key}</code>
                        <Badge variant="outline" className="text-[9px]">{fact.category}</Badge>
                        {fact.source && <span className="text-[9px] text-muted-foreground font-mono">{fact.source}</span>}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{fact.value}</p>
                      <div className="flex items-center gap-2 mt-1 text-[9px] text-muted-foreground font-mono">
                        <span>created {new Date(fact.created).toLocaleDateString()}</span>
                        {fact.ttl && <span>· expires {new Date(fact.ttl).toLocaleDateString()}</span>}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      {/* Vector DB Tab */}
      {tab === 'vector' && (
        <div className="space-y-2">
          {vectorEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Vector database is empty. Entries are indexed from conversations over time.</p>
          ) : (
            vectorEntries.map((entry) => (
              <Card key={entry.id}>
                <CardContent className="p-3">
                  <div className="flex items-start gap-3">
                    <Database className="size-3.5 text-indigo-500 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold font-mono">{entry.topic || entry.id.slice(0, 16)}</span>
                        {entry.tags && entry.tags.length > 0 && entry.tags.slice(0, 3).map(t => (
                          <span key={t} className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground">{t}</span>
                        ))}
                      </div>
                      {entry.summary && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{entry.summary}</p>
                      )}
                      {entry.timestamp && (
                        <p className="text-[9px] text-muted-foreground font-mono mt-1">{new Date(entry.timestamp).toLocaleString()}</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
          <p className="text-[10px] text-muted-foreground text-center">
            {vectorEntries.length} indexed entries · local vector DB
          </p>
        </div>
      )}

      {/* Core Memory Items Tab */}
      {tab === 'items' && (
        <div className="space-y-1.5">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No core memory items.</p>
          ) : (
            items.map((m) => (
              <Card key={m.id}>
                <CardContent className="p-3 flex items-start gap-3">
                  <div
                    className="size-1.5 rounded-full bg-primary mt-1.5 shrink-0"
                    style={{ opacity: Math.min(1, (m.injection?.score || 50) / 100) }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[9px]">{m.type}</Badge>
                      {m.pinned && <span className="text-[9px] text-amber-500 font-semibold">📌 pinned</span>}
                    </div>
                    <p className="text-sm mt-0.5">{m.text}</p>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono">
                      <span>score {m.injection?.score ?? '—'}</span>
                      {m.updated_at && <span>· updated {new Date(m.updated_at).toLocaleDateString()}</span>}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      {/* System Prompt Tab */}
      {tab === 'system' && (
        <Card>
          <CardContent className="p-4">
            {!systemPrompt ? (
              <p className="text-sm text-muted-foreground text-center py-4">Loading system prompt…</p>
            ) : (
              <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/80 leading-relaxed max-h-[60vh] overflow-y-auto">
                {systemPrompt}
              </pre>
            )}
            <p className="text-[10px] text-muted-foreground font-mono mt-3 text-right">
              {systemPrompt?.length ?? 0} chars
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
