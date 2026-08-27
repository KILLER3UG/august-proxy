import { describe, it, expect, vi, afterEach } from 'vitest';
import { timeAgo, absoluteDate } from '../utils';

describe('timeAgo (plan §5.2 list style)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders relative units up to a week', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:00Z'));
    const now = Date.now();
    expect(timeAgo(new Date(now - 30_000))).toBe('just now');
    expect(timeAgo(new Date(now - 5 * 60_000))).toBe('5m ago');
    expect(timeAgo(new Date(now - 3 * 3_600_000))).toBe('3h ago');
    expect(timeAgo(new Date(now - 3 * 86_400_000))).toBe('3d ago');
  });

  it('renders compact absolute dates beyond a week', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:00Z'));
    // Same year → "Aug 24" style (locale-formatted, no year).
    const out = timeAgo(new Date(Date.now() - 9 * 86_400_000));
    expect(out).toMatch(/^Aug \d+$/);
    // Other year includes the year.
    const old = timeAgo(new Date('2024-03-01T00:00:00Z'));
    expect(old).toContain('2024');
  });

  it('returns empty string for invalid input', () => {
    expect(timeAgo(null)).toBe('');
    expect(timeAgo('')).toBe('');
    expect(timeAgo('not-a-date')).toBe('');
  });
});

describe('absoluteDate', () => {
  it('formats a full hover timestamp', () => {
    const out = absoluteDate('2026-08-24T14:30:00');
    expect(out).toContain('Aug');
    expect(out).toContain('24');
    expect(out).toContain('2026');
  });

  it('returns empty string for invalid input', () => {
    expect(absoluteDate(undefined)).toBe('');
  });
});
