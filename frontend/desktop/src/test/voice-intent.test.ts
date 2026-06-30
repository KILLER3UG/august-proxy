/**
 * Tests for voice intent matching
 * 
 * Spec: docs/superpowers/specs/2026-06-30-voice-command-ui-infrastructure-design.md
 */

import { describe, it, expect } from 'vitest';
import { matchIntent, isLikelyCommand } from '@/api/voice/intent';
import { COMMANDS } from '@/sections/chat/commands-data';

describe('Voice Intent Matching', () => {
  describe('matchIntent', () => {
    it('should match exact trigger phrases', () => {
      const result = matchIntent('switch model', COMMANDS);
      expect(result).not.toBeNull();
      expect(result?.name).toBe('/model');
    });

    it('should match partial phrases', () => {
      const result = matchIntent('help', COMMANDS);
      expect(result).not.toBeNull();
      expect(result?.name).toBe('/help');
    });

    it('should match "show help"', () => {
      const result = matchIntent('show help', COMMANDS);
      expect(result).not.toBeNull();
      expect(result?.name).toBe('/help');
    });

    it('should match "clear chat"', () => {
      const result = matchIntent('clear chat', COMMANDS);
      expect(result).not.toBeNull();
      expect(result?.name).toBe('/clear');
    });

    it('should match "new session"', () => {
      const result = matchIntent('new session', COMMANDS);
      expect(result).not.toBeNull();
      expect(result?.name).toBe('/new');
    });

    it('should match "start over"', () => {
      const result = matchIntent('start over', COMMANDS);
      expect(result).not.toBeNull();
      expect(result?.name).toBe('/new');
    });

    it('should match "test me"', () => {
      const result = matchIntent('test me', COMMANDS);
      expect(result).not.toBeNull();
      expect(result?.name).toBe('/exam');
    });

    it('should match "quiz me on python"', () => {
      const result = matchIntent('quiz me on python', COMMANDS);
      expect(result).not.toBeNull();
      expect(result?.name).toBe('/exam');
    });

    it('should match "toggle debug"', () => {
      const result = matchIntent('toggle debug', COMMANDS);
      expect(result).not.toBeNull();
      expect(result?.name).toBe('/debug');
    });

    it('should return null for non-matching phrases', () => {
      const result = matchIntent('this is just dictation text', COMMANDS);
      expect(result).toBeNull();
    });

    it('should return null for empty input', () => {
      const result = matchIntent('', COMMANDS);
      expect(result).toBeNull();
    });

    it('should be case-insensitive', () => {
      const result = matchIntent('SWITCH MODEL', COMMANDS);
      expect(result).not.toBeNull();
      expect(result?.name).toBe('/model');
    });

    it('should handle punctuation in input', () => {
      const result = matchIntent('switch model!', COMMANDS);
      expect(result).not.toBeNull();
      expect(result?.name).toBe('/model');
    });
  });

  describe('isLikelyCommand', () => {
    it('should return true for short command-like phrases', () => {
      expect(isLikelyCommand('switch model', COMMANDS)).toBe(true);
      expect(isLikelyCommand('help', COMMANDS)).toBe(true);
      expect(isLikelyCommand('clear chat', COMMANDS)).toBe(true);
    });

    it('should return false for long phrases', () => {
      expect(isLikelyCommand('this is a very long sentence that is probably dictation', COMMANDS)).toBe(false);
    });

    it('should return false for non-command phrases', () => {
      expect(isLikelyCommand('write a poem about cats', COMMANDS)).toBe(false);
    });

    it('should return true for phrases containing trigger words', () => {
      expect(isLikelyCommand('show me help', COMMANDS)).toBe(true);
    });
  });

  describe('BM25 Ranking', () => {
    it('should prefer more specific matches', () => {
      // "switch model" should match /model better than other commands
      const result = matchIntent('switch model', COMMANDS);
      expect(result?.name).toBe('/model');
    });

    it('should handle similar triggers', () => {
      // "show help" vs "show commands" - both should match their respective commands
      const help = matchIntent('show help', COMMANDS);
      const commands = matchIntent('show commands', COMMANDS);
      expect(help?.name).toBe('/help');
      expect(commands?.name).toBe('/help'); // /commands is alias
    });
  });
});
