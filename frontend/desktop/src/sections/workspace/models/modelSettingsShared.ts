/* Shared constants and display helpers for Model settings views.
 * API format labels drive the provider create/edit dropdowns; fmtContextWindow
 * shortens token windows for list and detail badges.
 */

import type { ApiFormat } from '@/api/providers';
import type { LucideIcon } from 'lucide-react';
import { Server, Boxes, ArrowRightLeft, ShieldCheck, Brain, Gauge } from 'lucide-react';
import type { AggregatedModel } from '@/api/api-client';

/** API format dropdown options shown when adding or editing a provider.
 * Values must be canonical backend ids (camelCase). Labels stay user-facing.
 */
export const API_FORMATS: { value: ApiFormat; label: string }[] = [
  { value: 'openaiChat', label: 'chat/completions' },
  { value: 'anthropicMessages', label: 'v1/messages' },
  { value: 'openaiResponses', label: 'responses' },
];

/** Prefer chat completions for custom OpenAI-compatible gateways (OpenCode, Kilo, …). */
export const DEFAULT_API_FORMAT: ApiFormat = 'openaiChat';

export type ModelSettingsSubtab =
  | 'providers'
  | 'aliases'
  | 'quotas'
  | 'all-models'
  | 'fallback'
  | 'reflection'
  | 'fleet'
  | 'live';

/** Top-level Model settings views selectable from the View dropdown. */
export const SUBTABS: { key: ModelSettingsSubtab; label: string; icon: LucideIcon }[] = [
  { key: 'providers', label: 'Providers', icon: Server },
  { key: 'all-models', label: 'All models', icon: Boxes },
  { key: 'aliases', label: 'Aliases', icon: ArrowRightLeft },
  { key: 'fallback', label: 'Fallback', icon: ShieldCheck },
  { key: 'reflection', label: 'Background & Reflection', icon: Brain },
  { key: 'fleet', label: 'Model Fleet', icon: Brain },
  { key: 'live', label: 'Live (STT/TTS)', icon: Brain },
  { key: 'quotas', label: 'Quotas', icon: Gauge },
];

/** Formats a raw context-window size for compact list/detail badges (e.g. 128K, 1M). */
export function fmtContextWindow(n?: number) {
  if (!n) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
}

/**
 * Deduplicates aggregated catalog models by id for pickers (aliases, fallback,
 * background review). Normalizes isFree so the dropdown never sees undefined.
 */
export function uniqueAggregatedModels(
  models: AggregatedModel[] | undefined | null,
): AggregatedModel[] {
  const list: AggregatedModel[] = (models ?? []).map((m) => ({
    ...m,
    isFree: m.isFree ?? false,
  }));
  const seen = new Set<string>();
  return list.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}
