/**
 * Built-in slash commands. Importing this file (once, from main.tsx)
 * registers the command set on the singleton registry.
 *
 * The surface is intentionally tiny: /compact, /init, /btw, /goal.
 */

import { voiceCommandRegistry } from './registry';
import { voiceCommandEvents } from './registry-events';

// ── Built-ins ──────────────────────────────────────────────────────────────

voiceCommandRegistry.register({
  id: 'compact',
  triggers: ['compact', 'compress context', 'summarize history'],
  slashCommand: '/compact',
  category: 'core',
  description: 'Compress the session history to free context space',
  handler: ({ sessionId }) => {
    voiceCommandEvents.emit({ type: 'compact', sessionId });
  },
});

voiceCommandRegistry.register({
  id: 'init-aug',
  triggers: ['init', 'initialize', 'set up project', 'create agents md', 'create aug md'],
  slashCommand: '/init',
  category: 'core',
  description: 'Generate or refine AGENTS.md from workspace analysis',
  handler: ({ args }) => {
    voiceCommandEvents.emit({ type: 'init-aug', workspacePath: args || undefined });
  },
});

voiceCommandRegistry.register({
  id: 'btw',
  triggers: ['by the way'],
  slashCommand: '/btw',
  category: 'core',
  description: 'Ask a by-the-way question without losing context',
  handler: ({ args }) => {
    const text = args ? `/btw ${args}` : '/btw ';
    voiceCommandEvents.emit({ type: 'insert-text', text });
  },
});

voiceCommandRegistry.register({
  id: 'goal',
  triggers: ['set goal', 'goal', 'objective'],
  slashCommand: '/goal',
  category: 'core',
  description: 'Set, show, or clear the standing goal for this session',
  handler: ({ args, sessionId }) => {
    voiceCommandEvents.emit({ type: 'goal', sessionId, args: args ?? '' });
  },
});
