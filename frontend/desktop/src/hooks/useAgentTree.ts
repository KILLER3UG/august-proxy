/* ── Agent tree (React Query) ─────────────────────────────────────────── */
/* Hierarchical view of sub-agent jobs for a session. */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export type AgentNode = {
  id: string;
  parentId: string | null;
  sessionId: string | null;
  agentId: string;
  parentAgentId: string | null;
  depth: number;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'blocked';
  scope: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  resultSummary: string | null;
};

type Subtree = { root: AgentNode; children: Record<string, Subtree> };

export type AgentTreeResponse = {
  root: AgentNode;
  children: Record<string, Subtree>;
};

export function useAgentTree(rootId: string | null, maxDepth: number = 4) {
  return useQuery<AgentTreeResponse | null>({
    queryKey: ['agent-tree', rootId, maxDepth],
    queryFn: async () => {
      if (!rootId) return null;
      try {
        return await api.get<AgentTreeResponse>(
          `/api/agents/tree?root=${encodeURIComponent(rootId)}&maxDepth=${maxDepth}`
        );
      } catch {
        return null;
      }
    },
    enabled: !!rootId,
    refetchInterval: 3000,
    staleTime: 2000,
  });
}
