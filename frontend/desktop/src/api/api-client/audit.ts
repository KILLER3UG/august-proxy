/* Audit log, rollback list, and post-observation screenshot gallery. */

import { api } from '../client';

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  agentId?: string | null;
  sessionId?: string | null;
  action: string;
  target?: string | null;
  category?: string | null;
  mode?: string | null;
  critical?: boolean | null;
  approved?: boolean | null;
  approvalToken?: string | null;
  inputSummary?: unknown;
  beforeSummary?: unknown;
  afterSummary?: unknown;
  rollbackId?: string | null;
  postObservation?: {
    screenshotPath?: string | null;
    capturedAt?: string;
    focusedApp?: string | null;
  } | null;
  result: string;
  error?: string | null;
}

export function getAuditLog(
  opts:
    | number
    | {
        limit?: number;
        category?: string;
        actor?: string;
        action?: string;
        since?: string;
        until?: string;
        summary?: boolean;
      } = 200,
): Promise<{ entries: AuditEntry[]; total?: number; at?: string }> {
  if (typeof opts === 'number') {
    return api.get<{ entries: AuditEntry[]; total?: number; at?: string }>(
      `/api/audit?limit=${opts}`,
    );
  }
  const p = new URLSearchParams();
  if (opts.limit) p.set('limit', String(opts.limit));
  if (opts.category) p.set('category', opts.category);
  if (opts.actor) p.set('actor', opts.actor);
  if (opts.action) p.set('action', opts.action);
  if (opts.since) p.set('since', opts.since);
  if (opts.until) p.set('until', opts.until);
  if (opts.summary) p.set('summary', '1');
  const qs = p.toString();
  return api.get<{ entries: AuditEntry[]; total?: number; at?: string }>(
    `/api/audit${qs ? `?${qs}` : ''}`,
  );
}

export interface AuditSummary {
  count: number;
  byCategory: Record<string, number>;
  byResult: Record<string, number>;
  byActor: Record<string, number>;
  byCritical: { true: number; false: number; null: number };
  at: string;
}

export function getAuditSummary(): Promise<AuditSummary> {
  return api.get<AuditSummary>('/api/audit?summary=1');
}

export interface RollbackEntry {
  id: string;
  at: string;
  type: string;
  target: string;
  before: unknown;
  after: unknown;
  status: string;
}

export function getRollbackList(
  opts:
    | number
    | {
        limit?: number;
        status?: 'available' | 'undone' | 'failed';
        type?: string;
        summary?: boolean;
      } = 100,
): Promise<{ items: RollbackEntry[]; total?: number; at?: string }> {
  if (typeof opts === 'number') {
    return api.get<{ items: RollbackEntry[]; total?: number; at?: string }>(
      `/api/rollback?limit=${opts}`,
    );
  }
  const p = new URLSearchParams();
  if (opts.limit) p.set('limit', String(opts.limit));
  if (opts.status) p.set('status', opts.status);
  if (opts.type) p.set('type', opts.type);
  if (opts.summary) p.set('summary', '1');
  const qs = p.toString();
  return api.get<{ items: RollbackEntry[]; total?: number; at?: string }>(
    `/api/rollback${qs ? `?${qs}` : ''}`,
  );
}

export interface RollbackSummary {
  available: number;
  undone: number;
  failed: number;
  total: number;
  byType: Record<string, number>;
  at: string;
}

export function getRollbackSummary(): Promise<RollbackSummary> {
  return api.get<RollbackSummary>('/api/rollback?summary=1');
}

export interface PostObservation {
  id: string;
  screenshotPath: string;
  capturedAt: string;
  focusedApp: string | null;
  audit?: {
    id: string;
    at: string;
    action: string;
    target: string | null;
    result: string;
  };
}

export function getObservations(
  opts: { limit?: number; since?: string } = {},
): Promise<{ items: PostObservation[]; total: number; at: string }> {
  const p = new URLSearchParams();
  if (opts.limit) p.set('limit', String(opts.limit));
  if (opts.since) p.set('since', opts.since);
  const qs = p.toString();
  return api.get<{ items: PostObservation[]; total: number; at: string }>(
    `/api/observations${qs ? `?${qs}` : ''}`,
  );
}

export function getObservationUrl(id: string): string {
  return `/api/observations/${encodeURIComponent(id)}.png`;
}
