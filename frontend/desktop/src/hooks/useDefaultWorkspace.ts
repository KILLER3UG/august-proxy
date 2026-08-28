/* ── Default workspace (React Query) ────────────────────────────────── */
/* The OS user's home directory — the workspace a folderless "Tasks" chat */
/* points to, like a fresh terminal opening at ~. Resolved dynamically by  */
/* the backend per host user; never hardcoded in the UI.                   */

import { useQuery } from '@tanstack/react-query';
import { getDefaultWorkspace } from '@/api/workbench';

export function useDefaultWorkspace() {
  const q = useQuery<{ path: string }>({
    queryKey: ['default-workspace'],
    queryFn: () => getDefaultWorkspace(),
    // The home directory does not change within a session.
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return {
    path: q.data?.path ?? null,
    isLoading: q.isLoading,
  };
}
