/* ── useChatModels ────────────────────────────────────────────────────── */
/* Model list filtering + selection state for the chat composer.          */

import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useModels } from '@/hooks/useModels';
import { useProviderAvailability } from '@/hooks/useProviderAvailability';
import {
  loadHiddenModels,
  saveHiddenModels,
} from '@/components/overlays/ModelVisibilityModal';
import {
  type ModelItem,
  modelFromSession,
  loadLastModel,
  isLikelyReasoningModel,
} from '../model-display';
import { updateSessionModel, type Session } from '@/store/sessions';

export function useChatModels(sessionId: string | null, activeSession: Session | null) {
  const { models: aggregatedModels, isLoading: modelsLoading, refetch: refetchModels } =
    useModels();
  const { providers: availableProvidersList } = useProviderAvailability();

  const availableProviderKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const p of availableProvidersList) {
      if (!p.isAvailable) continue;
      if (p.id) keys.add(p.id);
      if (p.name) keys.add(p.name);
    }
    return keys;
  }, [availableProvidersList]);

  const models = useMemo((): ModelItem[] => {
    if (aggregatedModels.length === 0) return [];
    const list =
      availableProviderKeys.size === 0
        ? aggregatedModels
        : aggregatedModels.filter((m) => {
            if (m.provider === 'Alias') return true;
            if (availableProviderKeys.has(m.provider)) return true;
            // Catalog can refresh before availability — keep models whose
            // provider is not in the availability payload yet (newly added).
            const listed = availableProvidersList.some(
              (p) => p.id === m.provider || p.name === m.provider,
            );
            return !listed;
          });
    return list.map((m) => {
      // Catalog may omit / under-report reasoning for models that still take
      // effort (DeepSeek, Claude, GPT-5, …). Keep the id heuristic as a floor.
      const likely = isLikelyReasoningModel(m.id);
      return {
        id: m.id,
        name: m.name || m.id,
        provider: m.provider,
        contextWindow: m.contextWindow && m.contextWindow > 0 ? m.contextWindow : 128000,
        isFree: m.isFree,
        supportsReasoning: !!(m.supportsReasoning || likely),
        supportsThinking: !!(m.supportsThinking || likely),
      };
    });
  }, [aggregatedModels, availableProviderKeys, availableProvidersList]);

  const [hiddenModels, setHiddenModels] = useState<Set<string>>(loadHiddenModels);
  const [showModelVisibility, setShowModelVisibility] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ModelItem | null>(() => {
    return modelFromSession(activeSession) || loadLastModel();
  });
  const userSelectedRef = useRef<string | null>(null);

  const visibleModels = useMemo(
    () => models.filter((m) => !hiddenModels.has(m.id)),
    [models, hiddenModels],
  );

  const toggleModelVisibility = useCallback((id: string) => {
    setHiddenModels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveHiddenModels(next);
      return next;
    });
  }, []);

  const selectModel = useCallback(
    (m: ModelItem | null) => {
      if (!m) return;
      setSelectedModel(m);
      userSelectedRef.current = m.id;
      try {
        localStorage.setItem('august_last_model', JSON.stringify(m));
      } catch {
        /* ignore */
      }
      if (sessionId) updateSessionModel(sessionId, m.id, m.provider);
    },
    [sessionId],
  );

  // Keep selection aligned with session model when session switches.
  // Prefer the catalog match as soon as models are available so Effort /
  // Thinking flags are correct without waiting for a refetch round-trip.
  useEffect(() => {
    if (!sessionId || !activeSession?.model) return;
    userSelectedRef.current = activeSession.model;
    const modelId = activeSession.model;
    const fromCatalog = models.find(
      (m) => m.id === modelId || m.id.toLowerCase() === modelId.toLowerCase(),
    );
    setSelectedModel((prev) => {
      if (fromCatalog) return fromCatalog;
      if (prev?.id === modelId && prev.provider === activeSession.provider) {
        if (
          !prev.supportsReasoning &&
          !prev.supportsThinking &&
          isLikelyReasoningModel(modelId)
        ) {
          return {
            ...prev,
            supportsReasoning: true,
            supportsThinking: true,
          };
        }
        return prev;
      }
      return modelFromSession(activeSession) || prev;
    });
  }, [sessionId, activeSession, activeSession?.model, activeSession?.provider, models]);

  return {
    models,
    visibleModels,
    modelsLoading,
    refetchModels,
    hiddenModels,
    showModelVisibility,
    setShowModelVisibility,
    toggleModelVisibility,
    selectedModel,
    setSelectedModel,
    selectModel,
    userSelectedRef,
    isLikelyReasoningModel,
  };
}
