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

/** The minimum a picker needs. `AggregatedModel` satisfies it, and so does the
 *  narrower shape the visibility modal is handed — structural typing here is
 *  what lets all three surfaces share one grouping without casts. */
export interface ListableModel {
  id: string;
  name?: string;
  provider: string;
  isFree?: boolean;
  pinned?: boolean;
}

export interface ModelGroup<T extends ListableModel = ListableModel> {
  provider: string;
  items: T[];
}

/** Ids carry `-`, `_`, `/` and `:` where a person types a space, so both sides
 *  collapse to single spaces before comparison: "claude sonnet" has to reach
 *  `anthropic/claude-sonnet-4-5` and "kimi k3" has to reach `kimi-k3`. */
const collapseSeparators = (text: string): string =>
  text.toLowerCase().replace(/[-_/:]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * What a query matches. Deliberately wider than any previous surface: the
 * settings dropdown searched id + display name + provider, this card searched
 * name + provider and so could not find a model by the string the user actually
 * types when `name` is unset. An unmatched `name` falls through to the derived
 * display name rather than filtering as an empty string.
 */
export function modelMatchesQuery(m: ListableModel, query: string): boolean {
  const q = collapseSeparators(query);
  if (!q) return true;
  return collapseSeparators(
    [
      m.id,
      m.name && m.name.length > 0 ? m.name : getModelDisplayName(m.id),
      m.provider,
    ].join(' '),
  ).includes(q);
}

/**
 * Group by provider, preserving first-seen provider order, and rank inside each
 * group with the shared comparator (pinned, then free, then display name).
 */
export function groupModelsByProvider<T extends ListableModel>(
  models: readonly T[],
  query = '',
): ModelGroup<T>[] {
  const byProvider = new Map<string, T[]>();
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
export function flattenGroups<T extends ListableModel>(groups: readonly ModelGroup<T>[]): T[] {
  return groups.flatMap((g) => g.items);
}

/** Where each group starts in that flattened order, by group index. */
export function groupOffsets<T extends ListableModel>(groups: readonly ModelGroup<T>[]): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (const g of groups) {
    offsets.push(acc);
    acc += g.items.length;
  }
  return offsets;
}
