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
  findCatalogModel,
  modelFromSession,
  loadLastModel,
  isLikelyReasoningModel,
  estimateContextWindow,
  compareModelsRanked,
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
      // Prefer server catalog; accept snake_case if a proxy layer strips aliases.
      const raw = m as { context_window?: number };
      const reported =
        (m.contextWindow && m.contextWindow > 0 ? m.contextWindow : 0) ||
        (raw.context_window && raw.context_window > 0 ? raw.context_window : 0);
      const ctx = reported > 0 ? reported : estimateContextWindow(m.id);
      return {
        id: m.id,
        name: m.name || m.id,
        provider: m.provider,
        contextWindow: ctx,
        isFree: m.isFree,
        pinned: m.pinned,
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
    () => models.filter((m) => !hiddenModels.has(m.id)).sort(compareModelsRanked),
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
    const fromCatalog = findCatalogModel(models, modelId, activeSession.provider);
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

  // When the catalog hydrates/refreshes, upgrade a stale selected model
  // (localStorage / session stub often carried a fake 128k window).
  const selectedId = selectedModel?.id;
  const selectedProvider = selectedModel?.provider;
  useEffect(() => {
    if (!selectedId || models.length === 0) return;
    const fromCatalog = findCatalogModel(models, selectedId, selectedProvider);
    if (!fromCatalog) return;
    setSelectedModel((prev) => {
      if (!prev || (prev.id !== fromCatalog.id && prev.id.toLowerCase() !== fromCatalog.id.toLowerCase())) {
        return prev;
      }
      if (
        fromCatalog.contextWindow === prev.contextWindow &&
        fromCatalog.supportsReasoning === prev.supportsReasoning &&
        fromCatalog.supportsThinking === prev.supportsThinking &&
        fromCatalog.name === prev.name &&
        fromCatalog.provider === prev.provider
      ) {
        return prev;
      }
      try {
        localStorage.setItem('august_last_model', JSON.stringify(fromCatalog));
      } catch {
        /* ignore */
      }
      return fromCatalog;
    });
  }, [models, selectedId, selectedProvider]);

  /* No fallback belongs here. An earlier attempt added one — "when nothing is
   * selected, default to `visibleModels[0]`" — reasoning that `selectedModel` is
   * seeded from `modelFromSession(activeSession) || loadLastModel()` and that
   * the two effects above both bail when it is null, leaving Send permanently
   * disabled with a tooltip naming a deleted picker.
   *
   * The premise was wrong: `ChatThread.tsx` already owns that fallback
   * (`if (!targetId) return models[0]`), and it fires when the catalog arrives —
   * `models` changes identity after mount, so the first run's early return is
   * not the steady state. Adding a second fallback here made things WORSE: this
   * one picked `visibleModels[0]` (ranked, hidden-filtered) while the existing
   * one picks `models[0]` (raw order), so which model you got depended on hook
   * registration order; and it called raw `setSelectedModel`, so the default was
   * never persisted to `august_last_model` or the session. */
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
