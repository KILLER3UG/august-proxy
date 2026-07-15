import type { ProviderSetupResult } from '@/types/chat';

export interface ToolEntry {
  id: string;
  name: string;
  context?: string;
  preview?: string;
  summary?: string;
  error?: string;
  inlineDiff?: string;
  status: 'running' | 'done' | 'error';
  duration?: number;
  startedAt?: number;
  pendingApproval?: {
    message?: string;
    detail?: string;
    confirmationToken?: string;
  };
  /** For web_search: structured search hits to render as linked list */
  searchHits?: Array<{ title: string; url: string; snippet?: string }>;
  /** For setup_provider results: structured provider config to render an inline key field. */
  providerSetup?: ProviderSetupResult;
}
