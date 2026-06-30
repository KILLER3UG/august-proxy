/**
 * React Query hook for listing MCP (Model Context Protocol) tools available
 * through the backend's tool management endpoint.
 *
 * Spec: docs/superpowers/specs/2026-06-30-voice-subagent-provider-overhaul-design.md
 *
 * Usage:
 *   const { tools } = useMcpTools();
 *   // tools matches tool name patterns like 'calendar.list_events'
 */

import { useQuery } from '@tanstack/react-query';
import { manageAugustTools } from '@/api/api-client';

export interface McpTool {
  name: string;
  description: string;
  serverId: string;
}

export function useMcpTools() {
  const q = useQuery({
    queryKey: ['mcp-tools'],
    queryFn: async (): Promise<McpTool[]> => {
      const result = await manageAugustTools({ action: 'list', kind: 'mcp' });
      const tools = result.tools as Array<{ name: string; description: string; serverId?: string }> | undefined;
      if (!tools) return [];
      return tools.map(t => ({
        name: t.name,
        description: t.description,
        serverId: t.serverId ?? 'unknown',
      }));
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    retry: 1,
  });

  return {
    tools: q.data ?? [],
    isLoading: q.isLoading,
    error: q.error,
    refetch: q.refetch,
  };
}
