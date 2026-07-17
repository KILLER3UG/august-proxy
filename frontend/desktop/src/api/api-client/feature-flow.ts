/* Feature Flow pipeline visualization and proxy-path AUG.md injection toggle. */

import { api } from '../client';

export interface FeatureFlowEvent {
  id: string;
  traceId: string;
  feature: string;
  stage: string;
  status: 'running' | 'ok' | 'error';
  summary: string;
  error: string | null;
  durationMs: number | null;
  meta: Record<string, unknown>;
  at: string;
}

export interface FeatureInventoryItem {
  id: string;
  name: string;
  description: string;
  stages: string[];
}

export function getFeatureInventory(): Promise<{ features: FeatureInventoryItem[]; count: number }> {
  return api.get('/api/monitor/features');
}

export function getFeatureFlowEvents(
  limit = 200,
  feature?: string,
  status?: string,
): Promise<FeatureFlowEvent[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (feature) params.set('feature', feature);
  if (status) params.set('status', status);
  return api.get(`/api/monitor/events?${params.toString()}`);
}

export function openFeatureFlowEventStream(): EventSource {
  return new EventSource('/api/monitor/events/stream');
}

export function getInjectAugOnProxy(): Promise<{ enabled: boolean }> {
  return api.get('/api/config/inject-aug-on-proxy');
}

export function updateInjectAugOnProxy(body: {
  enabled: boolean;
}): Promise<{ enabled: boolean }> {
  return api.put('/api/config/inject-aug-on-proxy', body);
}
