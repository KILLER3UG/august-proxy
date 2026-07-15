import { describe, it, expect, beforeEach } from 'vitest';
import {
  useUiCustomizationStore,
  setDraftToken,
  applyDraftCustomization,
  resetAppliedCustomization,
  draftIsDirty,
  toColorInputValue,
} from '../ui-customization';

beforeEach(() => {
  resetAppliedCustomization();
  useUiCustomizationStore.setState({ draft: {}, applied: {} });
});

describe('ui-customization', () => {
  it('toColorInputValue expands short hex', () => {
    expect(toColorInputValue('#abc')).toBe('#aabbcc');
    expect(toColorInputValue('#AABBCC')).toBe('#AABBCC');
  });

  it('tracks dirty draft vs applied', () => {
    expect(draftIsDirty({}, {})).toBe(false);
    setDraftToken('background', '#112233');
    expect(draftIsDirty()).toBe(true);
    applyDraftCustomization();
    expect(draftIsDirty()).toBe(false);
    expect(useUiCustomizationStore.getState().applied.background).toBe('#112233');
  });

  it('clears applied on reset', () => {
    setDraftToken('primary', '#ff0000');
    applyDraftCustomization();
    resetAppliedCustomization();
    expect(useUiCustomizationStore.getState().applied).toEqual({});
    expect(useUiCustomizationStore.getState().draft).toEqual({});
  });
});
