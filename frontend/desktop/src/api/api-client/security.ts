/* Security write-back: allowed roots, filesystem scope, post-observation screenshots. */

import { api } from '../client';

export interface SecurityConfig {
  allowedRoots: string[];
  filesystemScope: 'allowlist' | 'root';
  postObservationScreenshot: boolean;
}

export function putSecurity(
  body: Partial<SecurityConfig>,
): Promise<{ ok: boolean; security: SecurityConfig }> {
  return api.put<{ ok: boolean; security: SecurityConfig }>('/api/security', body);
}
