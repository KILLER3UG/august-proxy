import { describe, it, expect, beforeEach } from 'vitest';
import {
  UI_TOKEN_DEFS,
  THEME_PRESETS,
  useUiCustomizationStore,
  setDraftToken,
  applyDraftCustomization,
  resetAppliedCustomization,
  applyExternalCustomization,
  draftIsDirty,
  toColorInputValue,
  isHexColor,
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

  it('exposes dedicated chat surface tokens', () => {
    const byId = Object.fromEntries(UI_TOKEN_DEFS.map((d) => [d.id, d.cssVar]));
    expect(byId.chatBackground).toBe('--dt-chat-background');
    expect(byId.chatInputBackground).toBe('--dt-chat-input-bg');
    expect(byId.userBubble).toBe('--dt-user-bubble');
  });

  it('applyExternalCustomization paints valid tokens and drops junk', () => {
    applyExternalCustomization({
      chatBackground: '#000000',
      chatInputBackground: 'not-a-color',
      fakeToken: '#ffffff',
    });

    const applied = useUiCustomizationStore.getState().applied;
    expect(applied.chatBackground).toBe('#000000');
    expect(applied.chatInputBackground).toBeUndefined();
    expect(Object.keys(applied)).not.toContain('fakeToken');
    expect(document.documentElement.style.getPropertyValue('--dt-chat-background')).toBe(
      '#000000',
    );
  });

  it('theme presets only use valid tokens and hex colors', () => {
    const validIds = new Set<string>(UI_TOKEN_DEFS.map((d) => d.id));
    expect(THEME_PRESETS.length).toBeGreaterThanOrEqual(5);
    for (const preset of THEME_PRESETS) {
      for (const [tokenId, color] of Object.entries(preset.map)) {
        expect(validIds.has(tokenId), `${preset.id}: unknown token ${tokenId}`).toBe(true);
        expect(isHexColor(color as string), `${preset.id}: ${tokenId} not hex`).toBe(true);
      }
    }
    // Default preset restores theme defaults (empty map).
    const defaultPreset = THEME_PRESETS.find((p) => p.id === 'default');
    expect(Object.keys(defaultPreset?.map ?? { x: 1 })).toHaveLength(0);
  });
});
