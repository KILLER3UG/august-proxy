import { describe, expect, it } from 'vitest';
import { modelDisplayParts } from '../model-display';

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
