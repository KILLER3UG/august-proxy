/**
 * Built-in slash commands. Importing this file (once, from main.tsx)
 * registers the command set on the singleton registry.
 *
 * The surface is intentionally tiny: /new, /compact, /init, /btw, /goal,
 * /circuit, /verbose.
 */

import { voiceCommandRegistry } from './registry';
import { voiceCommandEvents } from './registry-events';

// ── Built-ins ──────────────────────────────────────────────────────────────

voiceCommandRegistry.register({
  id: 'new-chat',
  triggers: ['new', 'new chat', 'new session', 'start over'],
  slashCommand: '/new',
  category: 'core',
  description: 'Start a new chat (Bot Chats compact instead — forever-chat)',
  handler: () => {
    voiceCommandEvents.emit({ type: 'new-session' });
  },
});

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

voiceCommandRegistry.register({
  id: 'circuit',
  triggers: ['circuit workbench', 'circuit mode', 'open circuit'],
  slashCommand: '/circuit',
  category: 'core',
  description:
    'Open (or "/circuit off") the circuit workbench — netlists, ngspice simulation, component search, and a 3D board panel in the sidebar',
  // Posts /circuit straight to the workbench: the backend flips
  // session.metadata.circuitMode and emits the `circuitMode` SSE event;
  // makeStreamHandlers then pops the Circuit drawer panel. The model call
  // is skipped for the command itself.
  handler: ({ args }) => {
    voiceCommandEvents.emit({ type: 'circuit', args: args ?? '' });
  },
});

voiceCommandRegistry.register({
  id: 'verbose',
  triggers: ['verbose', 'show raw output', 'debug output', 'raw tool output'],
  slashCommand: '/verbose',
  category: 'core',
  description:
    'Toggle raw tool output inline for this session ("/verbose off" to restore the minimal transcript)',
  // Pure client-side toggle (plan §4.2 item 4): flips the per-session flag
  // in lib/verbose-mode.ts; the transcript renderers read it directly.
  handler: ({ args, sessionId }) => {
    voiceCommandEvents.emit({ type: 'verbose', sessionId, args: args ?? '' });
  },
});
