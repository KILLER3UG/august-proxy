import { describe, expect, it } from 'vitest';
import { formatTokenCount } from '../token-display';

describe('formatTokenCount', () => {
  it('shows raw counts below 1k', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('compacts thousands with one decimal', () => {
    expect(formatTokenCount(1000)).toBe('1.0k');
    expect(formatTokenCount(1234)).toBe('1.2k');
    expect(formatTokenCount(129500)).toBe('129.5k');
  });

  it('compacts millions instead of showing four-digit k', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.0M');
    expect(formatTokenCount(1_720_600)).toBe('1.7M');
    expect(formatTokenCount(12_340_000)).toBe('12.3M');
  });
});
