/* Observability overview dashboard and live backend log ring buffer. */

import { api } from '../client';
import type { AuditSummary, RollbackSummary } from './audit';
import type { HostAgentHealth } from './host-agent';

export interface ObservabilityOverview {
  range: '7d' | '30d';
  audit: AuditSummary;
  rollback: RollbackSummary;
  appPolicy: {
    policies: Record<string, 'allow' | 'ask' | 'deny'>;
    counts: Record<'allow' | 'ask' | 'deny', number>;
    defaultPolicy: 'ask';
  };
  hostAgent: HostAgentHealth;
  at: string;
}

export function getObservabilityOverview(
  range: '7d' | '30d' = '30d',
): Promise<ObservabilityOverview> {
  return api.get<ObservabilityOverview>(`/api/observability/overview?range=${range}`);
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
export type LogCategory =
  | 'proxy_incoming'
  | 'proxy_upstream'
  | 'proxy_debug'
  | 'proxy_model_route'
  | 'proxy_context'
  | 'proxy_tools'
  | 'proxy_system_prompt'
  | 'auto_memory'
  | 'scheduler'
  | 'security'
  | 'error'
  | 'info';

export interface LogEvent {
  id: string;
  timestamp: number;
  category: string;
  level: LogLevel;
  message: string;
  metadata: Record<string, unknown> | null;
  raw: string | null;
}

export function getRecentLogs(limit = 200): Promise<{ events: LogEvent[]; count: number }> {
  const n = Math.max(1, Math.min(2000, Number(limit) || 200));
  return api.get<{ events: LogEvent[]; count: number }>(`/api/logs/recent?limit=${n}`);
}
