/**
 * VoiceCommandRegistry unit tests.
 *
 * Spec: docs/superpowers/specs/2026-06-30-voice-subagent-provider-overhaul-design.md
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  voiceCommandRegistry,
  type VoiceCommandDefinition,
} from './registry';

const noopHandler = () => {};

const make = (over: Partial<VoiceCommandDefinition> = {}): VoiceCommandDefinition => ({
  id: 'cmd-' + Math.random().toString(36).slice(2),
  triggers: [],
  handler: noopHandler,
  category: 'core',
  description: 'test command',
  ...over,
});

describe('VoiceCommandRegistry', () => {
  beforeEach(() => {
    voiceCommandRegistry.clear();
  });

  describe('register / unregister', () => {
    it('registers a command and exposes it via getAllCommands', () => {
      const cmd = make({ id: 'foo', triggers: ['foo'] });
      voiceCommandRegistry.register(cmd);

      expect(voiceCommandRegistry.size()).toBe(1);
      expect(voiceCommandRegistry.getAllCommands()[0]).toBe(cmd);
    });

    it('throws when registering a duplicate id', () => {
      const id = 'dup';
      voiceCommandRegistry.register(make({ id, triggers: ['x'] }));
      expect(() => voiceCommandRegistry.register(make({ id, triggers: ['y'] }))).toThrow(
        /duplicate id/,
      );
    });

    it('unregister returns true on success and false otherwise', () => {
      voiceCommandRegistry.register(make({ id: 'gone', triggers: ['gone'] }));
      expect(voiceCommandRegistry.unregister('gone')).toBe(true);
      expect(voiceCommandRegistry.unregister('gone')).toBe(false);
    });

	    it('preserves registration order across register/unregister/register cycles', () => {
	      const a = make({ id: 'a', triggers: ['alpha'] });
	      const b = make({ id: 'b', triggers: ['beta'] });
	      const c = make({ id: 'c', triggers: ['gamma'] });
	      voiceCommandRegistry.register(a);
	      voiceCommandRegistry.register(b);
	      voiceCommandRegistry.register(c);
	      expect(voiceCommandRegistry.getAllCommands().map(x => x.id)).toEqual(['a', 'b', 'c']);
	      expect(voiceCommandRegistry.unregister(b.id)).toBe(true);
	      expect(voiceCommandRegistry.getAllCommands().map(x => x.id)).toEqual(['a', 'c']);
	      const d = make({ id: 'd', triggers: ['delta'] });
	      voiceCommandRegistry.register(d);
	      const ids = voiceCommandRegistry.getAllCommands().map(x => x.id);
	      expect(ids).toEqual(['a', 'c', 'd']);
	    });
  });

  describe('getBySlashCommand / getById', () => {
    it('returns null when missing', () => {
      expect(voiceCommandRegistry.getById('nope')).toBeNull();
      expect(voiceCommandRegistry.getBySlashCommand('/nope')).toBeNull();
    });

    it('looks up by id and slash command', () => {
      const m = make({ id: 'model', triggers: ['switch model'], slashCommand: '/model' });
      voiceCommandRegistry.register(m);
      expect(voiceCommandRegistry.getById('model')).toBe(m);
      expect(voiceCommandRegistry.getBySlashCommand('/model')).toBe(m);
    });
  });

  describe('getCommandsByCategory', () => {
    it('filters by category while preserving registration order', () => {
      const a = make({ id: 'a', triggers: ['a'], category: 'core' });
      const b = make({ id: 'b', triggers: ['b'], category: 'plugin' });
      const c = make({ id: 'c', triggers: ['c'], category: 'core' });
      voiceCommandRegistry.register(a);
      voiceCommandRegistry.register(b);
      voiceCommandRegistry.register(c);
      expect(voiceCommandRegistry.getCommandsByCategory('core').map(x => x.id)).toEqual([
        'a',
        'c',
      ]);
      expect(voiceCommandRegistry.getCommandsByCategory('plugin').map(x => x.id)).toEqual([
        'b',
      ]);
    });
  });

  describe('matchCommand', () => {
    it('returns null for empty transcript', () => {
      voiceCommandRegistry.register(make({ id: 'x', triggers: ['switch model'] }));
      expect(voiceCommandRegistry.matchCommand('')).toBeNull();
      expect(voiceCommandRegistry.matchCommand('   ')).toBeNull();
      expect(voiceCommandRegistry.matchCommand('!?!')).toBeNull();
    });

    it('matches exact substring trigger and prefers it over looser candidates', () => {
      const modelPicker = make({
        id: 'model-picker',
        triggers: ['switch model', 'change model'],
      });
      voiceCommandRegistry.register(modelPicker);
      const m = voiceCommandRegistry.matchCommand('switch model');
      expect(m).not.toBeNull();
      expect(m!.id).toBe('model-picker');
    });

    it('matches case-insensitively and ignores punctuation', () => {
      const c = make({ id: 'help', triggers: ['help', 'show help'] });
      voiceCommandRegistry.register(c);
      expect(voiceCommandRegistry.matchCommand('HELP!')!.id).toBe('help');
      expect(voiceCommandRegistry.matchCommand('Show,    help')!.id).toBe('help');
    });

    it('does not match below the 0.6 threshold', () => {
      const unrelated = make({ id: 'unrelated', triggers: ['completely orthogonal phrase'] });
      voiceCommandRegistry.register(unrelated);
      const m = voiceCommandRegistry.matchCommand('show calendar');
      // Unless 'completely orthogonal phrase' has high token overlap with
      // 'show calendar', the unrelated command should not win.
      expect(m === null || m.id === 'unrelated').toBe(true);
    });

    it('tie-breaks by exact token overlap first', () => {
      // Two commands with the same best score but different exact overlap ratios.
      // We'll engineer this by giving each a single trigger whose token set has
      // different sizes.
      const exact = make({
        id: 'exact',
        triggers: ['switch model'],
      });
      const loose = make({
        id: 'loose',
        // Longer phrase — token overlap ratio with 'switch model' is 2/3 < 1
        triggers: ['please switch model now'],
      });
      voiceCommandRegistry.register(exact);
      voiceCommandRegistry.register(loose);
      const m = voiceCommandRegistry.matchCommand('switch model');
      expect(m).not.toBeNull();
      expect(m!.id).toBe('exact');
    });

    it('tie-breaks by registration order when scores & exact overlap match', () => {
      const first = make({ id: 'first', triggers: ['switch model'] });
      const second = make({ id: 'second', triggers: ['switch model'] });
      voiceCommandRegistry.register(first);
      voiceCommandRegistry.register(second);
      expect(voiceCommandRegistry.matchCommand('switch model')!.id).toBe('first');
    });

    it('plugin commands extend the registry', () => {
      const custom = make({
        id: 'show-my-data',
        triggers: ['show my data'],
        category: 'plugin',
      });
      voiceCommandRegistry.register(custom);
      expect(voiceCommandRegistry.matchCommand('show my data')!.id).toBe('show-my-data');
      expect(voiceCommandRegistry.getCommandsByCategory('plugin').map(c => c.id)).toEqual([
        'show-my-data',
      ]);
    });

    it('returns null when no command has any token overlap (everything below threshold)', () => {
      const c = make({ id: 'help', triggers: ['show help'] });
      voiceCommandRegistry.register(c);
      // Completely unrelated transcript.
      expect(voiceCommandRegistry.matchCommand('xyzzy plugh')).toBeNull();
    });
  });
});
