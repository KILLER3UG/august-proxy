/* ── useProviderHealth ─ light hook for the green online dot ──────── */
/* Polls /api/providers/health every 60s and exposes a map keyed by     */
/* provider name. Backend caches results for 30s, so this is cheap.      */

import { useEffect, useState, useCallback } from 'react';
import { api } from './client';

export interface ProviderHealth {
  provider: string;
  online: boolean;
  lastSuccessAt: number | null;
  latencyMs: number | null;
  error?: string;
}

interface ProviderHealthResponse {
  results: ProviderHealth[];
  at: number;
}

export function useProviderHealth(pollMs = 60_000) {
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async (force = false) => {
    try {
      const qs = force ? '?force=1' : '';
      const res = await api.get<ProviderHealthResponse>(`/api/providers/health${qs}`);
      setHealth(res.results || []);
      setLoaded(true);
    } catch (err) {
      // Network error or backend not running — don't blow up the UI
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh(false);
    if (pollMs <= 0) return;
    const id = window.setInterval(() => { void refresh(false); }, pollMs);
    return () => window.clearInterval(id);
  }, [refresh, pollMs]);

  const byProvider = new Map(health.map(h => [h.provider, h]));
  return { health, byProvider, loaded, refresh };
}
