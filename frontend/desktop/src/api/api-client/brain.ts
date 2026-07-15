/* Brain activity event feed and live SSE stream. */

import { api } from '../client';

export interface BrainEvent {
  id: string;
  category:
    | 'consolidation'
    | 'delta_engine'
    | 'heuristic'
    | 'review'
    | 'skill_genesis'
    | 'session';
  layer: string;
  summary: string;
  meta: Record<string, unknown>;
  at: string; // ISO8601 UTC, ends with Z
}

export function getBrainEvents(
  limit = 200,
  category?: BrainEvent['category'],
): Promise<BrainEvent[]> {
  const q = category ? `?limit=${limit}&category=${category}` : `?limit=${limit}`;
  return api.get<BrainEvent[]>(`/api/brain/events${q}`);
}

// SSE client returns an EventSource-like object that the caller closes.
// Kept here (not in a hook) so it can be tested in isolation.
export function openBrainEventStream(): EventSource {
  return new EventSource('/api/brain/events/stream');
}
