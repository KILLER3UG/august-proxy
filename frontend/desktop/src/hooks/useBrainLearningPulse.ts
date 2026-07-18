/* Soft “brain is alive / learning” pulse driven by Brain SSE events. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { openBrainEventStream } from '@/api/api-client';
import { getBrainConfig } from '@/api/workbench';

const LEARNING_MS = 2800;

/**
 * Returns whether Brain Orchestrator is enabled and whether a recent
 * brain SSE event should drive the learning animation.
 *
 * Uses plain fetch (not react-query) so settings rail tests / early mounts
 * do not require a QueryClientProvider.
 */
export function useBrainLearningPulse(): { enabled: boolean; learning: boolean } {
  const [learning, setLearning] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markLearning = useCallback(() => {
    setLearning(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setLearning(false), LEARNING_MS);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getBrainConfig()
      .then((res) => {
        if (!cancelled) setEnabled(Boolean(res.config?.enabled));
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });

    const es = openBrainEventStream();
    es.onmessage = () => {
      markLearning();
    };
    return () => {
      cancelled = true;
      es.close();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [markLearning]);

  return { enabled, learning };
}
