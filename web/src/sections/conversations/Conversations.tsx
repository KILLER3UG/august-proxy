import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Search, Pin, MessageSquare } from 'lucide-react';
import { formatTimeAgo, cn } from '@/lib/utils';
import { mockSessions, type Session } from '@/lib/mock';

export function Conversations() {
  const { data } = useQuery({
    queryKey: ['sessions'],
    queryFn: async () => {
      try { return await api.get<{ sessions: Session[] }>('/api/sessions?limit=50'); }
      catch { return { sessions: mockSessions }; }
    },
    refetchInterval: 5_000,
  });
  const sessions = data?.sessions ?? mockSessions;
  const [selected, setSelected] = useState<Session | null>(null);
  const [filter, setFilter] = useState('');

  const visible = sessions.filter((s) =>
    !filter || s.title.toLowerCase().includes(filter.toLowerCase()));

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
              placeholder="Filter sessions…"
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-secondary rounded-md border border-transparent focus:border-border focus:bg-background outline-none transition"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {visible.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelected(s)}
              className={cn(
                'w-full text-left rounded-md px-2.5 py-2 transition',
                selected?.id === s.id ? 'bg-accent' : 'hover:bg-accent/50',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium truncate flex-1">{s.title}</p>
                {s.messageCount > 20 && <Pin className="size-3 text-muted-foreground" />}
              </div>
              <p className="text-[11px] text-muted-foreground truncate mt-0.5">{s.lastMessage}</p>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono">
                <span>{formatTimeAgo(s.startedAt)}</span>
                <span>·</span>
                <span><MessageSquare className="inline size-2.5" /> {s.messageCount}</span>
                <span>·</span>
                <span className="truncate">{s.model}</span>
              </div>
            </button>
          ))}
          {visible.length === 0 && (
            <p className="text-center text-xs text-muted-foreground py-6">No sessions match "{filter}"</p>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-6">
        {selected ? (
          <SessionDetail session={selected} />
        ) : (
          <div className="h-full grid place-items-center text-sm text-muted-foreground">
            Select a session to view its transcript
          </div>
        )}
      </div>
    </div>
  );
}

function SessionDetail({ session }: { session: Session }) {
  return (
    <div className="space-y-4">
      <SectionHeader
        title={session.title}
        subtitle={`${session.model} · ${session.provider} · started ${formatTimeAgo(session.startedAt)}`}
        actions={
          <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
            <span>{session.messageCount} messages</span>
            <span>·</span>
            <span className="font-mono">{session.id}</span>
          </div>
        }
      />
      <Card>
        <CardContent className="p-5 text-sm text-muted-foreground italic">
          Full transcript view would render here. In the current build, the right rail pattern is used
          for transcript previews (see <code className="font-mono">RightRail</code> in <code className="font-mono">@/components/shell</code>).
        </CardContent>
      </Card>
    </div>
  );
}
