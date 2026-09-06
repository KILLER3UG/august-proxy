import type { IntegrationSetupResult, ProviderSetupResult } from '@/types/chat';
import type { ActionNeededPayload } from '@/components/chat/ActionNeededCard';

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
  /** For integration tools: structured payload to render an inline setup widget. */
  integrationSetup?: IntegrationSetupResult;
  /** For browser tools: a login-wall/escalation payload extracted from the
   *  result JSON. Extracted structurally because actionNeeded serializes
   *  last in the result and the summary is truncated long before it. */
  actionNeeded?: ActionNeededPayload;
  /** Live preview accumulator hit its cap — earlier chunks were dropped
   *  (mirrors MessageBlockToolCall). */
  previewDropped?: boolean;
  /** Backend truncated the SSE result content (100 KB cap). */
  contentTruncated?: boolean;
  /** Full (pre-truncation) byte length of the tool result, when known. */
  contentFullLength?: number;
}
