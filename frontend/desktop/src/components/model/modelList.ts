/* ── modelList — the one ordering every model picker must agree on ─────────
 *
 * Three surfaces used to build the same list three ways: the settings dropdown
 * grouped by provider and sorted free-then-name, this card grouped by provider
 * in whatever order the API returned, and the composer used the shared
 * comparator. The consequence was not cosmetic — `pinned` reordered the composer
 * list and did nothing in the other two, so a model you pinned appeared in a
 * different place depending on which surface you opened.
 *
 * Everything here is pure and order-only. Presentation stays in the surfaces:
 * a popover, an inline card and a composer menu are different shapes choosing
 * from the same sequence, and `groupOffsets` exists so each one can map its
 * keyboard cursor onto painted rows without re-walking the tree.
 */

import { compareModelsRanked, getModelDisplayName } from '@/sections/chat/model-display';
import type { AggregatedModel } from '@/api/api-client';

export interface ModelGroup {
  provider: string;
  items: AggregatedModel[];
}

/**
 * What a query matches. Deliberately wider than any previous surface: the
 * settings dropdown searched id + display name + provider, this card searched
 * name + provider and so could not find a model by the string the user actually
 * types when `name` is unset. An unmatched `name` falls through to the derived
 * display name rather than filtering as an empty string.
 */
export function modelMatchesQuery(m: AggregatedModel, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    m.id,
    m.name && m.name.length > 0 ? m.name : getModelDisplayName(m.id),
    m.provider,
  ].some((field) => String(field ?? '').toLowerCase().includes(q));
}

/**
 * Group by provider, preserving first-seen provider order, and rank inside each
 * group with the shared comparator (pinned, then free, then display name).
 */
export function groupModelsByProvider(
  models: readonly AggregatedModel[],
  query = '',
): ModelGroup[] {
  const byProvider = new Map<string, AggregatedModel[]>();
  for (const m of models) {
    if (!modelMatchesQuery(m, query)) continue;
    const key = m.provider || 'Unknown';
    const bucket = byProvider.get(key);
    if (bucket) bucket.push(m);
    else byProvider.set(key, [m]);
  }
  return [...byProvider.entries()].map(([provider, items]) => ({
    provider,
    items: [...items].sort(compareModelsRanked),
  }));
}

/** Paint order across groups — what a keyboard cursor indexes into. */
export function flattenGroups(groups: readonly ModelGroup[]): AggregatedModel[] {
  return groups.flatMap((g) => g.items);
}

/** Where each group starts in that flattened order, by group index. */
export function groupOffsets(groups: readonly ModelGroup[]): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (const g of groups) {
    offsets.push(acc);
    acc += g.items.length;
  }
  return offsets;
}
