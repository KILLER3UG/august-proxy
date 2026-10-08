/* The claim being tested is agreement, not appearance: every picker must put the
 * same model in the same place, which is the thing three hand-built lists could
 * not keep true. So these assert the sequence itself.
 */

import { describe, it, expect } from 'vitest';
import {
  flattenGroups,
  groupModelsByProvider,
  groupOffsets,
  modelMatchesQuery,
} from '../modelList';
import type { AggregatedModel } from '@/api/api-client';

const m = (over: Partial<AggregatedModel> & { id: string }): AggregatedModel => ({
  provider: 'anthropic',
  ...over,
});

const MODELS = [
  m({ id: 'anthropic/claude-haiku-4', name: 'Claude Haiku 4', isFree: true }),
  m({ id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', pinned: true }),
  m({ id: 'google/gemini-pro', name: 'Gemini Pro', provider: 'google', isFree: true }),
  // No `name` at all: an earlier surface could not find this one by typing.
  m({ id: 'openai/gpt-5-mini', provider: 'openai' }),
];

describe('groupModelsByProvider', () => {
  it('ranks pinned above free inside a group, not by arrival order', () => {
    const groups = groupModelsByProvider(MODELS);
    const anthropic = groups.find((g) => g.provider === 'anthropic');
    expect(anthropic?.items.map((i) => i.id)).toEqual([
      'anthropic/claude-sonnet-5',
      'anthropic/claude-haiku-4',
    ]);
  });

  it('keeps provider groups in first-seen order', () => {
    expect(groupModelsByProvider(MODELS).map((g) => g.provider)).toEqual([
      'anthropic',
      'google',
      'openai',
    ]);
  });

  it('finds a model that has no name by the string a user would type', () => {
    const found = groupModelsByProvider(MODELS, 'gpt-5');
    expect(flattenGroups(found).map((i) => i.id)).toEqual(['openai/gpt-5-mini']);
  });

  it('does not mutate the caller array while ranking', () => {
    const input = [...MODELS];
    groupModelsByProvider(input);
    expect(input[0].id).toBe('anthropic/claude-haiku-4');
  });
});

describe('flattenGroups and groupOffsets', () => {
  it('agree on where each group begins', () => {
    const groups = groupModelsByProvider(MODELS);
    const flat = flattenGroups(groups);
    const offsets = groupOffsets(groups);
    expect(flat).toHaveLength(4);
    groups.forEach((g, i) => {
      g.items.forEach((item, j) => {
        expect(flat[(offsets[i] ?? 0) + j]?.id).toBe(item.id);
      });
    });
  });
});

describe('modelMatchesQuery', () => {
  it('treats a blank query as everything, and matches on provider', () => {
    expect(modelMatchesQuery(MODELS[0], '   ')).toBe(true);
    expect(modelMatchesQuery(MODELS[2], 'google')).toBe(true);
    expect(modelMatchesQuery(MODELS[2], 'not-a-model')).toBe(false);
  });
});

describe('separator-agnostic matching', () => {
  /* Ids carry `-`, `_`, `/` and `:` where a person types a space. The composer
   * already collapsed both sides; the settings dropdown and the visibility
   * modal did not, so "claude haiku" found nothing in two of the three pickers
   * while finding it in the third. One matcher now answers for all of them. */
  it('finds a hyphenated id by the words a user types', () => {
    expect(modelMatchesQuery(MODELS[0], 'claude haiku')).toBe(true);
    expect(modelMatchesQuery(MODELS[1], 'claude sonnet')).toBe(true);
    // The collapse is one-directional: separators become spaces, so a
    // run-together query matches nothing. 'claudehaiku' is not 'claude haiku'.
    expect(modelMatchesQuery(MODELS[0], 'claudehaiku')).toBe(false);
  });

  it('finds a model with no name by its id words', () => {
    expect(modelMatchesQuery(MODELS[3], 'gpt 5 mini')).toBe(true);
    expect(modelMatchesQuery(MODELS[3], 'openai gpt-5')).toBe(true);
  });

  it('is applied by the grouping, so every filtered list agrees', () => {
    expect(groupModelsByProvider(MODELS, 'claude haiku').flatMap((g) => g.items).map((i) => i.id))
      .toEqual(['anthropic/claude-haiku-4']);
    expect(groupModelsByProvider(MODELS, 'gemini')).toHaveLength(1);
  });

  it('gives an unattributed model a group with a label', () => {
    const groups = groupModelsByProvider([m({ id: 'x', provider: '' })]);
    expect(groups.map((g) => g.provider)).toEqual(['Unknown']);
  });
});
