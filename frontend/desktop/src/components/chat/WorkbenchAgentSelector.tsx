import { Bot, Loader2 } from 'lucide-react';
import type { WorkbenchAgentRegistry } from '@/types/workbench';

export function WorkbenchAgentSelector({
  agents,
  selectedAgentId,
  loading,
  onSelect,
}: {
  agents: WorkbenchAgentRegistry | null;
  selectedAgentId: string;
  loading: boolean;
  onSelect: (agentId: string) => void;
}) {
  const agentList = agents?.agents ?? [];

  return (
    <div className="relative">
      <select
        value={selectedAgentId}
        onChange={(e) => onSelect(e.target.value)}
        disabled={loading}
        className="h-7 rounded-md border border-border bg-card px-2 text-[11px] font-medium outline-none focus:border-primary disabled:opacity-50"
        aria-label="Workbench agent"
      >
        {agentList.length > 0 ? agentList.map(agent => (
          <option key={agent.id} value={agent.id}>
            {agent.role || agent.id}
          </option>
        )) : (
          <option value={selectedAgentId}>{selectedAgentId || 'build'}</option>
        )}
      </select>
      {loading && <Loader2 className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 animate-spin text-muted-foreground" />}
      {!loading && <Bot className="pointer-events-none absolute right-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />}
    </div>
  );
}
