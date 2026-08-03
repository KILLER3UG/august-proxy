/* ── Brain learning data (React Query) ────────────────────────────────── */
/* Fetches learning data from /api/brain/learning */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';

export interface Heuristic {
  id: number;
  rule: string;
  source: string;
  category: string;
  confidence?: number;
  createdAt: string;
}

export interface AutoMemory {
  id: number;
  key: string;
  content: unknown;
  summary?: string;
  description?: string;
  label?: string;
  title?: string;
  importance: number;
  category?: string;
  source?: string;
  pinned?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface PendingSkill {
  id: number;
  name: string;
  description: string;
  triggerText?: string;
  draftPath?: string;
}

export interface ActiveProject {
  name?: string;
  path?: string | null;
  kind?: string | null;
  lastActiveAt?: string;
}

export interface LearningData {
  heuristics: Heuristic[];
  heuristicCount: number;
  coreFacts: unknown;
  userProfile: unknown;
  autoMemories: AutoMemory[];
  activeProjects: ActiveProject[];
  currentContext: string;
  sleepCycle: { lastRunAt: string | null; lastMerged: number; lastPromoted: number; lastDeleted: number };
  deltaEngine: { consentGranted: boolean; queueSize: number; lastFlushAt: string | null };
  pendingSkills: PendingSkill[];
}

export function useLearningData() {
  return useQuery<LearningData>({
    queryKey: ['brain-learning'],
    queryFn: async () => {
      const json = await api.get<Record<string, unknown>>('/api/brain/learning');
      const deltaBlock =
        (json.deltaEngine as Record<string, unknown> | undefined) ??
        (json.delta_engine as Record<string, unknown> | undefined);
      // Wire format is camelCase per the v3 brain API contract
      return {
        heuristics: (json.heuristics ?? []) as Heuristic[],
        heuristicCount: (json.heuristicCount ?? 0) as number,
        coreFacts: json.coreFacts ?? null,
        userProfile: json.userProfile ?? null,
        autoMemories: (json.autoMemories ?? []) as AutoMemory[],
        activeProjects: (json.activeProjects ?? []) as ActiveProject[],
        currentContext:
          typeof json.currentContext === 'string' ? json.currentContext : '',
        sleepCycle: {
          lastRunAt: ((json.sleepCycle as Record<string, unknown>)?.lastRunAt ?? null) as string | null,
          lastMerged: ((json.sleepCycle as Record<string, unknown>)?.lastMerged ?? 0) as number,
          lastPromoted: ((json.sleepCycle as Record<string, unknown>)?.lastPromoted ?? 0) as number,
          lastDeleted: ((json.sleepCycle as Record<string, unknown>)?.lastDeleted ?? 0) as number,
        },
        deltaEngine: {
          consentGranted: (deltaBlock?.consentGranted ?? false) as boolean,
          queueSize: (deltaBlock?.queueSize ?? 0) as number,
          lastFlushAt: (deltaBlock?.lastFlushAt ?? null) as string | null,
        },
        pendingSkills: (json.pendingSkills ?? []) as PendingSkill[],
      };
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useDeleteMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/api/memory/auto/${id}`),
    onSuccess: () => {
      toast.success('Memory deleted');
      void qc.invalidateQueries({ queryKey: ['brain-learning'] });
    },
    onError: (e: Error) => toast.error(e.message || 'Delete failed'),
  });
}
