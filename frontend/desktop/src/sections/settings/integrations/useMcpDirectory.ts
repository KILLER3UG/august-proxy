/* ── useMcpDirectory — the backend's curated MCP recipe list ─────────── */
/* The backend serves a hand-written list of install RECIPES, not a
 * discovered registry, and reports per recipe whether its launcher is on
 * PATH on this machine. The directory uses that to say out loud when a
 * recipe cannot start here, instead of offering an install that is
 * guaranteed to fail. */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export interface McpDirectoryEntry {
  id: string;
  name: string;
  packageName?: string;
  packageVersion?: string;
  kind?: string;
  command?: string;
  args?: string[];
  /** False when the recipe's launcher is not on PATH on this host. */
  launcherAvailable?: boolean;
}

export interface McpDirectoryResponse {
  source?: string;
  /** Always false — the list is curated, not discovered. */
  discovered?: boolean;
  note?: string;
  entries?: McpDirectoryEntry[];
}

/**
 * Fallback wording, used when the backend cannot be reached. It says the
 * same thing the backend says, so the surface never implies a live
 * registry search.
 */
export const CURATED_DIRECTORY_NOTE =
  'A curated list of install recipes baked into August — not a discovered registry. ' +
  'August does not search npm, PyPI, GitHub or the MCP registry, and an entry here is a ' +
  'recipe or a sign-in slot, not a capability August already has.';

export function useMcpDirectory(enabled = true) {
  return useQuery({
    queryKey: ['mcp-directory'],
    queryFn: () => api.get<McpDirectoryResponse>('/api/mcp/directory'),
    // Short: launcher availability is a fact about THIS machine, and the
    // user can change it (installing uv) while August is running.
    staleTime: 30_000,
    retry: false,
    enabled,
  });
}
