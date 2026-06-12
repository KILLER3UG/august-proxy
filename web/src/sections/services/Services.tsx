import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Server, Wrench, CheckCircle2, AlertCircle, Loader2, PauseCircle, PlayCircle, Power } from 'lucide-react';

interface McpServer {
  name: string;
  status: 'running' | 'stopped' | 'disabled' | 'not_started' | 'error';
  toolCount: number;
  enabled: boolean;
  command: string;
  source?: string;
  error?: string | null;
  tools?: string[];
}

const SERVER_ICONS: Record<string, { icon: string; color: string }> = {
  'blender':        { icon: 'B', color: 'from-orange-500 to-amber-600' },
  'brave-search':   { icon: 'Br', color: 'from-red-500 to-rose-600' },
  'browser-use':    { icon: 'Bu', color: 'from-blue-500 to-cyan-500' },
  'fetch':          { icon: 'F', color: 'from-green-500 to-emerald-500' },
  'filesystem':     { icon: 'Fs', color: 'from-slate-500 to-zinc-600' },
  'github':         { icon: 'Gh', color: 'from-slate-700 to-slate-900' },
  'linear':         { icon: 'Li', color: 'from-indigo-500 to-purple-600' },
  'minimax':        { icon: 'Mm', color: 'from-purple-500 to-violet-600' },
  'n8n':            { icon: 'N', color: 'from-red-600 to-orange-500' },
  'notebooklm-mcp': { icon: 'Nl', color: 'from-sky-500 to-blue-600' },
  'playwright':     { icon: 'Pw', color: 'from-green-600 to-teal-500' },
};

function getStatusMeta(status: string) {
  switch (status) {
    case 'running':
      return { label: 'Running', tone: 'good' as const, icon: CheckCircle2 };
    case 'error':
      return { label: 'Error', tone: 'bad' as const, icon: AlertCircle };
    case 'starting':
      return { label: 'Starting', tone: 'warn' as const, icon: Loader2 };
    case 'disabled':
      return { label: 'Disabled', tone: 'muted' as const, icon: PauseCircle };
    default:
      return { label: 'Stopped', tone: 'muted' as const, icon: Power };
  }
}

export function Services() {
  const { data, isLoading } = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: async () => {
      try {
        const res = await api.get<{ status: McpServer[] }>('/ui/mcp');
        return res.status ?? [];
      } catch {
        return [] as McpServer[];
      }
    },
    refetchInterval: 15_000,
  });

  const servers = data ?? [];

  const running = servers.filter(s => s.status === 'running');
  const enabled = servers.filter(s => s.enabled && s.status !== 'running');
  const disabled = servers.filter(s => !s.enabled);

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Services"
        subtitle={`${running.length} running · ${servers.length} total MCP servers`}
      />

      {isLoading && servers.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-40 rounded-lg bg-muted/30 animate-pulse" />
          ))}
        </div>
      ) : servers.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No MCP servers configured.</p>
      ) : (
        <>
          {running.length > 0 && (
            <div>
              <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold mb-2 px-1">Running</h3>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {running.map(s => <ServerCard key={s.name} server={s} />)}
              </div>
            </div>
          )}

          {enabled.length > 0 && (
            <div>
              <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold mb-2 px-1">Enabled</h3>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {enabled.map(s => <ServerCard key={s.name} server={s} />)}
              </div>
            </div>
          )}

          {disabled.length > 0 && (
            <div>
              <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold mb-2 px-1">Disabled</h3>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {disabled.map(s => <ServerCard key={s.name} server={s} />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ServerCard({ server }: { server: McpServer }) {
  const meta = getStatusMeta(server.status);
  const StatusIcon = meta.icon;
  const visual = SERVER_ICONS[server.name] ?? { icon: server.name[0]?.toUpperCase() ?? '?', color: 'from-slate-500 to-slate-700' };

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={cn(
            'size-9 rounded-lg bg-gradient-to-br grid place-items-center text-white text-[11px] font-bold shrink-0',
            visual.color,
          )}>
            {visual.icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold font-mono truncate">{server.name}</h3>
              <span className={cn(
                'inline-flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded-full',
                meta.tone === 'good' && 'bg-emerald-500/10 text-emerald-500',
                meta.tone === 'bad' && 'bg-red-500/10 text-red-500',
                meta.tone === 'warn' && 'bg-amber-500/10 text-amber-500',
                meta.tone === 'muted' && 'bg-muted text-muted-foreground',
              )}>
                <StatusIcon className={cn('size-2.5', meta.tone === 'warn' && 'animate-spin')} />
                {meta.label}
              </span>
            </div>

            {server.toolCount > 0 && (
              <p className="text-[10px] text-muted-foreground mt-1 font-mono flex items-center gap-1">
                <Wrench className="size-2.5" /> {server.toolCount} tools
              </p>
            )}

            {server.error && (
              <p className="text-[10px] text-red-500/80 mt-1 truncate" title={server.error}>
                {server.error}
              </p>
            )}

            {server.tools && server.tools.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {server.tools.slice(0, 3).map(tool => (
                  <span key={tool} className="inline-flex items-center rounded bg-secondary text-secondary-foreground px-1.5 py-0.5 text-[9px] font-mono truncate max-w-[120px]">
                    {tool}
                  </span>
                ))}
                {server.tools.length > 3 && (
                  <span className="text-[9px] text-muted-foreground">+{server.tools.length - 3}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
