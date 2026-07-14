import { useQuery } from '@tanstack/react-query';
import { SectionHeader } from '@/components/SectionHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ShieldCheck, ShieldAlert, Inbox, Users, GitBranch } from 'lucide-react';
import { listWorkbenchAgents } from '@/api/workbench';

/**
 * Agent registry view. Reads /api/workbench/agents (roles, modes, scopes,
 * team skills). Read-only here; editing stays in backend config. Approval
 * gate / capabilities surface as a summary; live approval is in chat.
 */
export function Agents() {
  const { data: registry, isLoading } = useQuery({
    queryKey: ['workbench-agents', 'build'],
    queryFn: () => listWorkbenchAgents('build'),
  });

  const agents = registry?.agents ?? [];

  return (
    <div className="p-6 space-y-6">
      <SectionHeader
        title="Agents"
        subtitle={
          isLoading
            ? 'Loading agent registry…'
            : `${agents.length} agent${agents.length === 1 ? '' : 's'} registered · inheritance: ${registry?.inheritance?.rule || 'default'}`
        }
      />

      {/* Approval gate summary */}
      {registry && (
        <Card className="border-warning/30 bg-warning/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <ShieldCheck className="size-5 text-warning shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-semibold">Approval gate</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  {registry?.agents?.[0]?.permissions
                    ? 'Mutating tools require an approved plan before execution. Read/search/inspect tools remain available.'
                    : 'No explicit permission policy detected — mutating tools follow the default gate.'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {agents.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-10 grid place-items-center text-center text-muted-foreground">
            <Inbox className="size-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm">No agents registered.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}

interface AgentData {
  id: string;
  team?: boolean;
  role?: string;
  mode?: string;
  goal?: string;
  scopes?: string[];
  tools?: string[];
  teamSkills?: Array<{ name: string; description: string; trigger?: string; category?: string }>;
  effectivePermissions?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  inheritedFrom?: string | null;
}

function AgentCard({ agent }: { agent: AgentData }) {
  const scopes = Array.isArray(agent.scopes) ? agent.scopes : [];
  const tools = Array.isArray(agent.tools) ? agent.tools : [];
  const teamSkills = Array.isArray(agent.teamSkills) ? agent.teamSkills : [];
  const effectivePerms = agent.effectivePermissions || agent.permissions || {};

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm flex items-center gap-2">
              <span className="font-mono">{agent.id}</span>
              {agent.team && (
                <Badge variant="secondary" className="text-[9px]">
                  <Users className="size-2.5 mr-0.5" /> team
                </Badge>
              )}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {agent.role || agent.mode || 'agent'}
            </p>
          </div>
          {agent.goal && (
            <Badge variant="outline" className="text-[9px] shrink-0">{agent.goal}</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {scopes.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Scopes</p>
            <div className="flex flex-wrap gap-1">
              {scopes.map((s: string) => (
                <Badge key={s} variant="outline" className="text-[9px]">{s}</Badge>
              ))}
            </div>
          </div>
        )}

        {agent.inheritedFrom && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono">
            <GitBranch className="size-3" />
            inherits from <span className="text-foreground">{agent.inheritedFrom}</span>
          </div>
        )}

        {teamSkills.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Team skills</p>
            <div className="space-y-1">
              {teamSkills.slice(0, 4).map((sk: { name: string; description: string; trigger?: string; category?: string }, i: number) => (
                <div key={sk.name || i} className="text-[11px]">
                  <span className="font-mono text-foreground">{sk.name}</span>
                  <span className="text-muted-foreground"> — {sk.description}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {Object.keys(effectivePerms).length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
              <ShieldAlert className="size-2.5" /> Effective permissions
            </p>
            <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-muted/40 rounded p-2">
              {JSON.stringify(effectivePerms, null, 2)}
            </pre>
          </div>
        )}

        {tools.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{tools.length} tools</p>
            <p className="text-[11px] text-muted-foreground font-mono truncate">
              {tools.slice(0, 6).join(', ')}{tools.length > 6 ? ` +${tools.length - 6}` : ''}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
