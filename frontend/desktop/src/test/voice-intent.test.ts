/**
 * Tests for voice intent matching (registry-based)
 *
 * Spec: docs/superpowers/specs/2026-06-30-voice-subagent-provider-overhaul-design.md
 *
 * These tests exercise the same transcript → command behavior the previous
 * BM25 implementation provided, but through VoiceCommandRegistry so the
 * algorithm and command set are unified.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  voiceCommandRegistry,
  toDisplayCommand,
  getDisplayCommands,
} from '@/api/voice/registry';
import type { VoiceCommandDefinition } from '@/api/voice/registry';

const noopHandler = () => {};

function registerCoreFixtures(): void {
  const defs: Array<Partial<VoiceCommandDefinition> & { id: string; triggers: string[]; slash: string }> = [
    { id: 'model-picker',  slash: '/model',  triggers: ['model', 'switch model', 'change model', 'pick model'] },
    { id: 'provider',      slash: '/provider',triggers: ['provider', 'switch provider', 'change provider'] },
    { id: 'help',          slash: '/help',   triggers: ['help', 'show help', 'show commands', 'what can you do'] },
    { id: 'commands',      slash: '/commands',triggers: ['commands', 'list commands'] },
    { id: 'clear-chat',    slash: '/clear',  triggers: ['clear', 'clear chat', 'clear screen'] },
    { id: 'new-chat',      slash: '/new',    triggers: ['new', 'new chat', 'new session', 'start over'] },
    { id: 'reset',         slash: '/reset',  triggers: ['reset', 'reset chat', 'reset history'] },
    { id: 'debug',         slash: '/debug',  triggers: ['debug', 'toggle debug', 'debug mode'] },
    { id: 'goal',          slash: '/goal',   triggers: ['goal', 'set goal'] },
    { id: 'btw',           slash: '/btw',    triggers: ['by the way', 'btw'] },
    { id: 'load-session',  slash: '/load',   triggers: ['load', 'load skill'] },
    { id: 'skills',        slash: '/skills', triggers: ['skills', 'search skills', 'show skills'] },
    { id: 'exam',          slash: '/exam',   triggers: ['exam', 'test me', 'quiz me', 'exam mode'] },
  ];
  for (const d of defs) {
    voiceCommandRegistry.register({
      id: d.id,
      triggers: d.triggers,
      slashCommand: d.slash,
      handler: noopHandler,
      category: 'core',
      description: `Test fixture for ${d.id}`,
    });
  }
}

describe('Voice Intent Matching (registry-based)', () => {
  beforeEach(() => {
    voiceCommandRegistry.clear();
    registerCoreFixtures();
  });

  function bySlash(slash: string) {
    return voiceCommandRegistry
      .getAllCommands()
      .find(d => d.slashCommand === slash);
  }

  describe('matchCommand — exact triggers', () => {
    it('matches "switch model" -> /model', () => {
      expect(voiceCommandRegistry.matchCommand('switch model')?.id).toBe('model-picker');
    });
    it('matches "help" -> /help', () => {
      expect(voiceCommandRegistry.matchCommand('help')?.id).toBe('help');
    });
    it('matches "show help" -> /help', () => {
      expect(voiceCommandRegistry.matchCommand('show help')?.id).toBe('help');
    });
    it('matches "clear chat" -> /clear', () => {
      expect(voiceCommandRegistry.matchCommand('clear chat')?.id).toBe('clear-chat');
    });
    it('matches "new session" -> /new', () => {
      expect(voiceCommandRegistry.matchCommand('new session')?.id).toBe('new-chat');
    });
    it('matches "start over" -> /new', () => {
      expect(voiceCommandRegistry.matchCommand('start over')?.id).toBe('new-chat');
    });
    it('matches "test me" -> /exam', () => {
      expect(voiceCommandRegistry.matchCommand('test me')?.id).toBe('exam');
    });
    it('matches "quiz me on python" -> /exam', () => {
      expect(voiceCommandRegistry.matchCommand('quiz me on python')?.id).toBe('exam');
    });
    it('matches "toggle debug" -> /debug', () => {
      expect(voiceCommandRegistry.matchCommand('toggle debug')?.id).toBe('debug');
    });
  });

  describe('matchCommand — negative cases', () => {
    it('returns null for non-matching phrases', () => {
      // Long dictation phrase with no overlap with any registered trigger.
      expect(voiceCommandRegistry.matchCommand('this is just dictation text')).toBeNull();
    });
    it('returns null for empty input', () => {
      expect(voiceCommandRegistry.matchCommand('')).toBeNull();
    });
  });

  describe('matchCommand — robustness', () => {
    it('is case-insensitive', () => {
      expect(voiceCommandRegistry.matchCommand('SWITCH MODEL')?.id).toBe('model-picker');
    });
    it('handles punctuation', () => {
      expect(voiceCommandRegistry.matchCommand('switch model!')?.id).toBe('model-picker');
    });
  });

  describe('Ranking', () => {
    it('prefers the most specific match', () => {
      // "switch model" should match /model better than other commands
      expect(voiceCommandRegistry.matchCommand('switch model')?.id).toBe('model-picker');
    });
    it('handles similar triggers correctly', () => {
      const help = voiceCommandRegistry.matchCommand('show help');
      const cmds = voiceCommandRegistry.matchCommand('show commands');
      // Both should match help variants
      expect(['help', 'commands']).toContain(help?.id);
      expect(['help', 'commands']).toContain(cmds?.id);
    });
  });

  describe('Display helpers', () => {
    it('toDisplayCommand converts a definition', () => {
      const def = bySlash('/model')!;
      const d = toDisplayCommand(def);
      expect(d.name).toBe('/model');
      expect(d.desc).toContain('Test fixture');
      expect(d.category).toBe('core');
      expect(d.voiceTriggers).toContain('switch model');
    });
    it('getDisplayCommands returns one entry per definition', () => {
      const list = getDisplayCommands();
      expect(list.length).toBe(voiceCommandRegistry.size());
      expect(list.every(d => typeof d.name === 'string' && d.name.startsWith('/'))).toBe(true);
    });
  });
});
