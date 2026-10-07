import { describe, expect, it } from 'vitest';
import {
  findCatalogModel,
  findModelByKey,
  modelDisplayParts,
  modelKey,
  type ModelItem,
} from '../model-display';

describe('modelDisplayParts null-safety', () => {
  // Sidebar rows call this unconditionally for status lines; a session with
  // no model set used to throw (id.search on undefined) and black-screen the
  // whole app. It must degrade to empty parts instead.
  it('returns empty parts for a missing model instead of throwing', () => {
    expect(() => modelDisplayParts(undefined)).not.toThrow();
    expect(modelDisplayParts(undefined)).toEqual({ name: '', tag: '' });
    expect(modelDisplayParts(null)).toEqual({ name: '', tag: '' });
    expect(modelDisplayParts('')).toEqual({ name: '', tag: '' });
  });

  it('still parses a real model id', () => {
    const { name } = modelDisplayParts('B.AI/qwen3.8-flash');
    expect(name).toBeTruthy();
  });
});

// Real ids from the KiloCode / OpenRouter catalogs. Only the HYPHEN form of a
// tier was known as a variant, so `…laguna-s-2.1:free` fell through to titleCase
// and rendered as "Laguna S 2.1:Free" — the tier inside the name, capital F.
describe('modelDisplayParts — colon tiers (`vendor/model:free`)', () => {
  it('moves the tier into the tag, where the hyphen form already put it', () => {
    expect(modelDisplayParts('poolside/laguna-s-2.1:free')).toEqual({
      name: 'Laguna S 2.1',
      tag: 'poolside:Free',
    });
    expect(modelDisplayParts('stepfun/step-3.7-flash:free')).toEqual({
      name: 'Step 3.7 Flash',
      tag: 'stepfun:Free',
    });
    // Both tiers at once: the hyphen variant and the colon suffix.
    expect(modelDisplayParts('dots-studio/dots-3-note-preview:free')).toEqual({
      name: 'Dots 3 Note',
      tag: 'dots-studio:Preview Free',
    });
  });

  it('leaves the shapes it already handled alone', () => {
    expect(modelDisplayParts('deepseek-v4-flash')).toEqual({
      name: 'DeepSeek V4-Flash',
      tag: '',
    });
    expect(modelDisplayParts('deepseek-v4-flash-free')).toEqual({
      name: 'DeepSeek V4-Flash',
      tag: 'Free',
    });
    expect(modelDisplayParts('anthropic/claude-sonnet-4-6')).toEqual({
      name: 'Sonnet 4 6',
      tag: 'anthropic',
    });
  });
});

// These duplicates are not hypothetical: data/providers.json lists both ids under
// OpenRouter AND KiloCode, with OpenRouter first in the aggregate.
const entry = (id: string, provider: string): ModelItem => ({
  id,
  name: id,
  provider,
  contextWindow: 128000,
});
const CATALOG = [
  entry('stepfun/step-3.7-flash', 'OpenRouter'),
  entry('openrouter/auto', 'OpenRouter'),
  entry('stepfun/step-3.7-flash', 'KiloCode'),
  entry('stepfun/step-3.7-flash:free', 'KiloCode'),
  // Its id carries a slash of its own, which is what the key encoding must survive.
  entry('poolside/laguna-s-2.1:free', 'KiloCode'),
  entry('openrouter/auto', 'KiloCode'),
];

describe('findCatalogModel — ids are not unique across gateways', () => {
  it('keeps a selection on the gateway the user chose', () => {
    expect(findCatalogModel(CATALOG, 'stepfun/step-3.7-flash', 'KiloCode')?.provider).toBe(
      'KiloCode',
    );
    expect(findCatalogModel(CATALOG, 'openrouter/auto', 'KiloCode')?.provider).toBe('KiloCode');
    expect(findCatalogModel(CATALOG, 'stepfun/step-3.7-flash', 'OpenRouter')?.provider).toBe(
      'OpenRouter',
    );
  });

  it('falls back to an id-only match when that provider no longer lists it', () => {
    // A renamed or removed gateway must not strand the session with no model.
    expect(findCatalogModel(CATALOG, 'stepfun/step-3.7-flash', 'OldGate')?.provider).toBe(
      'OpenRouter',
    );
    expect(findCatalogModel(CATALOG, 'STEPFUN/Step-3.7-Flash', 'KiloCode')?.provider).toBe(
      'KiloCode',
    );
  });

  it('returns undefined for an id nothing lists', () => {
    expect(findCatalogModel(CATALOG, 'nope/nope', 'KiloCode')).toBeUndefined();
    expect(findCatalogModel([], 'nope/nope')).toBeUndefined();
  });
});

describe('modelKey / findModelByKey — a select value that names the gateway', () => {
  const kilo = entry('stepfun/step-3.7-flash', 'KiloCode');
  const free = entry('poolside/laguna-s-2.1:free', 'KiloCode');

  it('round-trips an id that itself contains a slash', () => {
    const found = findModelByKey(CATALOG, modelKey(free));
    expect(found?.provider).toBe('KiloCode');
    expect(found?.id).toBe('poolside/laguna-s-2.1:free');
  });

  it('picks the gateway the key names, not the first match', () => {
    expect(findModelByKey(CATALOG, modelKey(kilo))?.provider).toBe('KiloCode');
    expect(
      findModelByKey(CATALOG, modelKey(entry('stepfun/step-3.7-flash', 'OpenRouter')))?.provider,
    ).toBe('OpenRouter');
  });

  it('still resolves a preset stored as a bare id', () => {
    expect(findModelByKey(CATALOG, 'stepfun/step-3.7-flash')?.provider).toBe('OpenRouter');
    // A bare id that happens to contain a slash must not be read as `provider/id`.
    expect(findModelByKey(CATALOG, 'poolside/laguna-s-2.1:free')?.provider).toBe('KiloCode');
    expect(findModelByKey(CATALOG, '')).toBeUndefined();
  });
});
