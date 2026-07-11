/* ── Workspace files (React Query) ────────────────────────────────────── */
/* Fetches workspace file listings from /api/workspace/files */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes?: number;
}

export interface WorkspaceFilesResponse {
  files: FileNode[];
}

export function useWorkspaceFiles(path: string | null) {
  return useQuery<WorkspaceFilesResponse>({
    queryKey: ['workspace-files', path],
    queryFn: async () => {
      if (!path) throw new Error('No path provided');
      return api.get<WorkspaceFilesResponse>(`/api/workspace/files?path=${encodeURIComponent(path)}`);
    },
    enabled: !!path,
    staleTime: 10_000,
  });
}
