/* External API gateway access — Bearer key gate for /v1/* proxy surface. */

import { api } from '../client';

export interface ExternalAccessConfig {
  enabled: boolean;
  hasKey: boolean;
  /** Masked preview of GATEWAY_API_KEY, or null when not configured. */
  keyPreview: string | null;
  /** Where the key is loaded from (env or generated config). */
  source: 'env' | 'config' | null;
  endpoints: {
    anthropic: string;
    openai: string;
    models: string;
  };
}

export function getExternalAccessConfig(): Promise<ExternalAccessConfig> {
  return api.get<ExternalAccessConfig>('/api/config/external-access');
}

export function updateExternalAccessConfig(body: {
  enabled: boolean;
}): Promise<{
  enabled: boolean;
  hasKey: boolean;
  keyPreview: string | null;
  source: string | null;
}> {
  return api.put('/api/config/external-access', body);
}

export function generateGatewayApiKey(): Promise<{
  apiKey: string;
  hasKey: boolean;
  keyPreview: string | null;
  source: string | null;
  message?: string;
}> {
  return api.post('/api/config/external-access/generate-key', {});
}
