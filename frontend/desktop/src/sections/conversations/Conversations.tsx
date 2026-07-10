import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Search, MessageSquare, Inbox } from 'lucide-react';
import { formatTimeAgo, cn } from '@/lib/utils';
import { getConversations, type ConversationsResponse, type RequestEntry } from '@/api/api-client';

interface ConversationItem {
  reqId: string;
  clientType: string;
  model: string;
  status: string;
  date?: string;
  messages: Array<{ role: string; content: string }>;
  response?: unknown;
  finishReason?: string | null;
  error?: string | null;
}

function normalize(grouped: ConversationsResponse | undefined): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const [clientType, entries] of Object.entries(grouped || {})) {
    for (const e of entries as Array<RequestEntry & { details: { messages: unknown; response: unknown; finishReason?: string | null; error?: string | null } | null }>) {
      const rawMessages = e.details?.messages;
      const messages = toMessages(rawMessages);
      items.push({
        reqId: e.reqId,
        clientType,
        model: e.model || 'unknown',
        status: e.status || 'unknown',
        date: e.date,
        messages,
        response: e.details?.response,
        finishReason: e.details?.finishReason,
        error: e.details?.error,
      });
    }
  }
  return items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function toMessages(raw: unknown): Array<{ role: string; content: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m: unknown) => {
      const msg = m as { role?: string; content?: string | Array<unknown> | { text?: string; content?: string } };
      const role = msg?.role || 'unknown';
      let content = '';
      if (typeof msg?.content === 'string') content = msg.content;
      else if (Array.isArray(msg?.content)) {
        content = msg.content
          .map((b: unknown) => {
            const block = b as { text?: string; content?: string; type?: string };
            return typeof b === 'string' ? b : block?.text || block?.content || block?.type || '';
          })
          .filter(Boolean)
          .join('\n');
      } else if (msg?.content && typeof msg.content === 'object') {
        content = String(msg.content.text || msg.content.content || '');
      }
      return { role, content };
    })
    .filter((m) => m.content);
}

export function Conversations() {
  const { data, isLoading } = useQuery({
    queryKey: ['conversations', 'today'],
    queryFn: () => getConversations('today'),
    refetchInterval: 5_000,
  });

  const items = useMemo(() => normalize(data), [data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const visible = items.filter((it) => {
    if (!filter) return true;
    const hay = `${it.clientType} ${it.model} ${it.messages.map((m) => m.content).join(' ')}`.toLowerCase();
    return hay.includes(filter.toLowerCase());
  });

  const selected = items.find((i) => i.reqId === selectedId) ?? null;

  return (
    <div className="flex h-full">
      <div className="w-80 shrink-0 border-r border-border flex flex-col">
        <div className="p-4 border-b border-border">
          <SectionHeader title="Conversations" />
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by client, model, or text…"
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-secondary rounded-md border border-transparent focus:border-border focus:bg-background outline-none transition"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading && (
            <p className="text-center text-xs text-muted-foreground py-6">Loading…</p>
          )}
          {!isLoading && visible.length === 0 && (
            <p className="text-center text-xs text-muted-foreground py-6">
              {filter ? `No conversations match "${filter}"` : 'No conversations captured yet'}
            </p>
          )}
          {visible.map((it) => (
            <button
              key={it.reqId}
              onClick={() => setSelectedId(it.reqId)}
              className={cn(
                'w-full text-left rounded-md px-2.5 py-2 transition',
                selectedId === it.reqId ? 'bg-accent' : 'hover:bg-accent/50',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium truncate flex-1">{it.clientType}</p>
                <Badge variant={it.status === 'error' ? 'destructive' : 'secondary'} className="text-[9px]">
                  {it.status.slice(0, 8)}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                {it.messages[it.messages.length - 1]?.content || it.model}
              </p>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono">
                <span>{it.date ? formatTimeAgo(it.date) : '—'}</span>
                <span>·</span>
                <span><MessageSquare className="inline size-2.5" /> {it.messages.length}</span>
                <span>·</span>
                <span className="truncate">{it.model}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-6">
        {selected ? (
          <ConversationDetail item={selected} />
        ) : (
          <div className="h-full grid place-items-center text-sm text-muted-foreground">
            <div className="text-center">
              <Inbox className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              Select a conversation to view its transcript
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationDetail({ item }: { item: ConversationItem }) {
  return (
    <div className="space-y-4">
      <SectionHeader
        title={item.clientType}
        subtitle={`${item.model} · ${item.status} · ${item.date ? formatTimeAgo(item.date) : ''}`}
        actions={
          <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
            <span>{item.messages.length} messages</span>
            <span>·</span>
            <span className="font-mono">{item.reqId}</span>
          </div>
        }
      />

      {item.error && (
        <Card>
          <CardContent className="p-4">
            <p className="text-[10px] uppercase tracking-wider text-destructive mb-1">Error</p>
            <pre className="text-xs font-mono whitespace-pre-wrap break-all text-destructive">{item.error}</pre>
          </CardContent>
        </Card>
      )}

      {item.messages.length === 0 ? (
        <Card>
          <CardContent className="p-5 text-sm text-muted-foreground italic">
            No message bodies were captured for this request.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {item.messages.map((m, i) => (
            <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
              <Card className={cn('max-w-[85%]', m.role === 'user' ? 'bg-secondary' : 'bg-card')}>
                <CardContent className="py-2.5 px-3">
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1 font-mono">
                    <span className="font-semibold">{m.role}</span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap break-words">{m.content}</p>
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      )}

      {item.finishReason && (
        <p className="text-[10px] text-muted-foreground font-mono px-1">
          finish_reason: {item.finishReason}
        </p>
      )}
    </div>
  );
}
