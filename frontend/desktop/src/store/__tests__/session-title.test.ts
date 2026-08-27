/* ── session title helpers (plan §5.2) ─────────────────────────────── */

import { describe, it, expect } from 'vitest';
import {
  defaultSessionTitle,
  isPlaceholderTitle,
  deriveSnippetTitle,
} from '../sessions/helpers';

describe('defaultSessionTitle / isPlaceholderTitle (plan §5.2)', () => {
  it('never uses timestamps as names', () => {
    expect(defaultSessionTitle()).toBe('New chat');
    expect(defaultSessionTitle()).not.toMatch(/\d{4}/);
  });

  it('matches placeholder + legacy date-stamped titles', () => {
    expect(isPlaceholderTitle('New chat')).toBe(true);
    expect(isPlaceholderTitle('new session')).toBe(true);
    expect(isPlaceholderTitle('')).toBe(true);
    expect(isPlaceholderTitle(null)).toBe(true);
    expect(isPlaceholderTitle('Chat 2026-07-15 14:30')).toBe(true);
    expect(isPlaceholderTitle('Chat 2026-07-15 14:30 UTC')).toBe(true);
    expect(isPlaceholderTitle('Fix memory consolidation')).toBe(false);
  });
});

describe('deriveSnippetTitle (plan §5.2 — immediate title from first message)', () => {
  it('takes the first line, collapsed to single spaces', () => {
    expect(deriveSnippetTitle('Fix   memory\nconsolidation bug')).toBe('Fix memory');
  });

  it('caps at 48 chars with an ellipsis', () => {
    const long = 'a'.repeat(80);
    const out = deriveSnippetTitle(long);
    expect(out).toBe('a'.repeat(48) + '…');
  });

  it('skips slash commands', () => {
    expect(deriveSnippetTitle('/goal do the thing')).toBe('');
  });

  it('skips too-short text', () => {
    expect(deriveSnippetTitle('a')).toBe('');
    expect(deriveSnippetTitle('')).toBe('');
  });

  it('strips accidental role prefixes', () => {
    expect(deriveSnippetTitle('user: Refactor provider router')).toBe('Refactor provider router');
  });

  it('matches the backend derive_title_from_message on a CRLF dump', () => {
    expect(deriveSnippetTitle('UART testbench review\r\nmore context')).toBe('UART testbench review');
  });
});
