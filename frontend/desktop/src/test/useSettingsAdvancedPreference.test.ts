/* ── useSettingsAdvancedPreference — localStorage-backed toggle hook ── */
/* Mirrors the pattern in useSubagentViewPreference.test. The hook persists
 * the rail's "Show advanced" toggle to localStorage so first-time users
 * keep seeing the beginner-friendly list across reloads. */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSettingsAdvancedPreference } from '@/hooks/useSettingsAdvancedPreference';

const STORAGE_KEY = 'august-settings-advanced';

describe('useSettingsAdvancedPreference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to showAdvanced = false when localStorage is empty', () => {
    const { result } = renderHook(() => useSettingsAdvancedPreference());
    expect(result.current.showAdvanced).toBe(false);
  });

  it('toggle() flips false → true', () => {
    const { result } = renderHook(() => useSettingsAdvancedPreference());
    expect(result.current.showAdvanced).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.showAdvanced).toBe(true);
  });

  it('toggle() flips true → false', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const { result } = renderHook(() => useSettingsAdvancedPreference());
    expect(result.current.showAdvanced).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.showAdvanced).toBe(false);
  });

  it('setShowAdvanced(true) sets the value to true', () => {
    const { result } = renderHook(() => useSettingsAdvancedPreference());
    act(() => result.current.setShowAdvanced(true));
    expect(result.current.showAdvanced).toBe(true);
  });

  it('setShowAdvanced(false) sets the value to false', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const { result } = renderHook(() => useSettingsAdvancedPreference());
    expect(result.current.showAdvanced).toBe(true);
    act(() => result.current.setShowAdvanced(false));
    expect(result.current.showAdvanced).toBe(false);
  });

  it('accepts the updater form setShowAdvanced(prev => !prev)', () => {
    const { result } = renderHook(() => useSettingsAdvancedPreference());
    act(() => result.current.setShowAdvanced((prev) => !prev));
    expect(result.current.showAdvanced).toBe(true);
    act(() => result.current.setShowAdvanced((prev) => !prev));
    expect(result.current.showAdvanced).toBe(false);
  });

  it('persists changes to localStorage', () => {
    const { result } = renderHook(() => useSettingsAdvancedPreference());
    act(() => result.current.toggle());
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
    act(() => result.current.toggle());
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
  });

  it('on remount, persists the value from localStorage', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const first = renderHook(() => useSettingsAdvancedPreference());
    expect(first.result.current.showAdvanced).toBe(true);
    first.unmount();

    const second = renderHook(() => useSettingsAdvancedPreference());
    expect(second.result.current.showAdvanced).toBe(true);
  });

  it('handles a corrupt localStorage value gracefully (defaults to false)', () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-boolean');
    const { result } = renderHook(() => useSettingsAdvancedPreference());
    expect(result.current.showAdvanced).toBe(false);
  });

  it('treats localStorage = "false" as the explicit false default', () => {
    localStorage.setItem(STORAGE_KEY, 'false');
    const { result } = renderHook(() => useSettingsAdvancedPreference());
    expect(result.current.showAdvanced).toBe(false);
  });

  it('returns the same toggle/setShowAdvanced references across re-renders', () => {
    const { result, rerender } = renderHook(() => useSettingsAdvancedPreference());
    const firstToggle = result.current.toggle;
    const firstSet = result.current.setShowAdvanced;
    rerender();
    expect(result.current.toggle).toBe(firstToggle);
    expect(result.current.setShowAdvanced).toBe(firstSet);
  });
});