import { describe, expect, it } from 'vitest';
import { formatTokenCount, formatTokensPerSecond } from '../token-display';

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

describe('formatTokensPerSecond', () => {
  it('returns null without timing or output (old persisted turns)', () => {
    expect(formatTokensPerSecond({ outputTokens: 500 })).toBeNull();
    expect(formatTokensPerSecond({ outputTokens: 0, durationMs: 5000 })).toBeNull();
    expect(formatTokensPerSecond({ outputTokens: 500, durationMs: 0 })).toBeNull();
  });

  it('computes output tokens per generation-second', () => {
    expect(formatTokensPerSecond({ outputTokens: 500, durationMs: 10_000 })).toBe('50.0');
    expect(formatTokensPerSecond({ outputTokens: 1200, durationMs: 10_000 })).toBe('120');
    expect(formatTokensPerSecond({ outputTokens: 45, durationMs: 1000 })).toBe('45.0');
  });
});
