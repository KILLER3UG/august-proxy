/* ── Brain learning data (React Query) ────────────────────────────────── */
/* Fetches learning data from /api/brain/learning */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export interface Heuristic {
  id: number;
  rule: string;
  source: string;
  category: string;
  createdAt: string;
}

export interface AutoMemory {
  id: number;
  key: string;
  content: string;
  importance: number;
  createdAt?: string;
}

export interface PendingSkill {
  id: number;
  name: string;
  description: string;
  triggerText?: string;
}

export interface LearningData {
  heuristics: Heuristic[];
  heuristicCount: number;
  coreFacts: unknown;
  userProfile: unknown;
  autoMemories: AutoMemory[];
  sleepCycle: { lastRunAt: string | null; lastMerged: number; lastPromoted: number; lastDeleted: number };
  deltaEngine: { consentGranted: boolean; queueSize: number; lastFlushAt: string | null };
  pendingSkills: PendingSkill[];
}

export function useLearningData() {
  return useQuery<LearningData>({
    queryKey: ['brain-learning'],
    queryFn: async () => {
      const json = await api.get<Record<string, unknown>>('/api/brain/learning');
      // Wire format is camelCase per the v3 brain API contract
      return {
        heuristics: (json.heuristics ?? []) as Heuristic[],
        heuristicCount: (json.heuristicCount ?? 0) as number,
        coreFacts: json.coreFacts ?? null,
        userProfile: json.userProfile ?? null,
        autoMemories: (json.autoMemories ?? []) as AutoMemory[],
        sleepCycle: {
          lastRunAt: ((json.sleepCycle as Record<string, unknown>)?.lastRunAt ?? null) as string | null,
          lastMerged: ((json.sleepCycle as Record<string, unknown>)?.lastMerged ?? 0) as number,
          lastPromoted: ((json.sleepCycle as Record<string, unknown>)?.lastPromoted ?? 0) as number,
          lastDeleted: ((json.sleepCycle as Record<string, unknown>)?.lastDeleted ?? 0) as number,
        },
        deltaEngine: {
          consentGranted: ((json.deltaEngine as Record<string, unknown>)?.consentGranted ?? false) as boolean,
          queueSize: ((json.deltaEngine as Record<string, unknown>)?.queueSize ?? 0) as number,
          lastFlushAt: ((json.deltaEngine as Record<string, unknown>)?.lastFlushAt ?? null) as string | null,
        },
        pendingSkills: (json.pendingSkills ?? []) as PendingSkill[],
      };
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}
