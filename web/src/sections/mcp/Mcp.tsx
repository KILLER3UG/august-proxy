import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusPill } from '@/components/StatusPill';
import { Server, Wrench, CheckCircle2 } from 'lucide-react';

interface McpServer {
  name: string;
  status: 'running' | 'stopped' | 'disabled' | 'not_started' | 'error';
  toolCount: number;
  enabled: boolean;
  command: string;
}

interface Skill {
  name: string;
  description: string;
  enabled: boolean;
  category?: string;
  trigger?: string;
}

/** `/ui/mcp` returns `{ servers: config[], status: runtimeStatus[] }` */
interface McpResponse {
  servers: any[];
  status: McpServer[];
}

export function Mcp() {
  const [tab, setTab] = useState<'servers' | 'skills'>('servers');

  const mcpQuery = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: async () => {
      try {
        const data = await api.get<McpResponse>('/ui/mcp');
        // Use the runtime status array (has status/toolCount), not the config array
        return data.status ?? [];
      } catch {
        return [] as McpServer[];
      }
    },
    refetchInterval: 15_000,
  });

  const skillsQuery = useQuery({
    queryKey: ['skills'],
    queryFn: async () => {
      try {
        const data = await api.get<{ skills: Skill[] }>('/ui/skills');
        return (data.skills ?? []).map(s => ({
          ...s,
          // Infer category from description or trigger if not present
          category: s.category || (s.trigger ? 'automation' : 'general'),
        }));
      } catch {
        return [] as Skill[];
      }
    },
    refetchInterval: 15_000,
  });

  const servers = mcpQuery.data ?? [];
  const skills = skillsQuery.data ?? [];

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="MCP & Skills"
        subtitle="Model Context Protocol servers and curated skills available to the agent."
        actions={
          <div className="flex items-center gap-1 text-[10px]">
            <button onClick={() => setTab('servers')} className={`rounded-md px-2 py-1 transition ${tab === 'servers' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}>Servers</button>
            <button onClick={() => setTab('skills')} className={`rounded-md px-2 py-1 transition ${tab === 'skills' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}>Skills</button>
          </div>
        }
      />

      {tab === 'servers' && (
        <div className="space-y-2">
          {servers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No MCP servers configured.</p>
          ) : (
            servers.map((s) => {
              const tone = s.status === 'running' ? 'good' : s.status === 'disabled' ? 'muted' : 'bad';
              return (
                <Card key={s.name}>
                  <CardContent className="p-4 flex items-center gap-4">
                    <Server className="size-4 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold font-mono">{s.name}</h3>
                        <span className="text-[10px] text-muted-foreground">{s.command ? s.command.split('/').pop() : ''}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono">
                        <Wrench className="size-2.5" /> {s.toolCount} tools
                        {s.enabled === false && <span className="text-destructive">· disabled</span>}
                      </div>
                    </div>
                    <StatusPill tone={tone} label={s.status.replace(/_/g, ' ')} />
                    {s.status === 'running' && (
                      <button className="text-xs text-muted-foreground hover:text-foreground transition">Stop</button>
                    )}
                    {s.status !== 'running' && (
                      <button className="text-xs text-primary hover:text-primary/80 transition">Start</button>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      )}

      {tab === 'skills' && (
        <div className="grid gap-2 sm:grid-cols-2">
          {skills.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8 col-span-full">No skills loaded.</p>
          ) : (
            skills.map((s) => (
              <Card key={s.name}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold font-mono">{s.name}</h3>
                        {s.category && <Badge variant="outline" className="text-[9px]">{s.category}</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{s.description}</p>
                      {s.trigger && <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">trigger: {s.trigger}</p>}
                    </div>
                    <button
                      aria-label={s.enabled ? 'Disable skill' : 'Enable skill'}
                      className={`relative w-9 h-5 rounded-full transition ${s.enabled ? 'bg-primary' : 'bg-muted'}`}
                    >
                      <span className={`absolute top-0.5 size-4 rounded-full bg-white transition ${s.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                    </button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}
