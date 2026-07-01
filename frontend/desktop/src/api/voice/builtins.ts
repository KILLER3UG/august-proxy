/**
 * Built-in voice commands. Importing this file (once, from main.tsx) registers
 * the default command set on the singleton registry. Future plugins can call
 * voiceCommandRegistry.register(...) to extend at runtime.
 *
 * Spec: docs/superpowers/specs/2026-06-30-voice-subagent-provider-overhaul-design.md
 *
 * UI cards are attached in their respective modules (see ModelPickerCard,
 * CalendarCard) so this file stays free of React component wiring at import
 * time — important because tests run registry code without React being mounted.
 */

import { voiceCommandRegistry } from './registry';
import { voiceCommandEvents } from './registry-events';
import { CommandHelpCard } from '@/sections/chat/CommandHelpCard';
import { CalendarCard } from '@/sections/chat/CalendarCard';
import { ModelPickerCard } from '@/sections/chat/ModelPickerCard';

// ── Built-ins ──────────────────────────────────────────────────────────────

voiceCommandRegistry.register({
  id: 'model-picker',
  triggers: ['switch model', 'change model', 'select model'],
  slashCommand: '/model',
  category: 'core',
  description: 'Switch the model used by the current session',
  uiCard: ModelPickerCard as unknown as React.ComponentType<{
    sessionId: string;
    onDismiss: () => void;
    context?: Record<string, unknown>;
  }>,
  handler: ({ sessionId }) => {
    voiceCommandEvents.emit({
      type: 'push-card',
      commandId: 'model-picker',
      context: { sessionId },
    });
  },
});

voiceCommandRegistry.register({
  id: 'calendar-view',
  triggers: ['show calendar', 'my calendar', 'show events'],
  slashCommand: '/calendar',
  category: 'core',
  description: 'Show a week-view of upcoming events',
  uiCard: CalendarCard as unknown as React.ComponentType<{
    sessionId: string;
    onDismiss: () => void;
    context?: Record<string, unknown>;
  }>,
  handler: ({ sessionId }) => {
    voiceCommandEvents.emit({
      type: 'push-card',
      commandId: 'calendar-view',
      context: { sessionId },
    });
  },
});

voiceCommandRegistry.register({
  id: 'help',
  triggers: ['help', 'show commands', 'what can you do'],
  slashCommand: '/help',
  category: 'core',
  description: 'Show available commands and capabilities',
  uiCard: CommandHelpCard as unknown as React.ComponentType<{
    sessionId: string;
    onDismiss: () => void;
    context?: Record<string, unknown>;
  }>,
  handler: () => {
    voiceCommandEvents.emit({ type: 'push-card', commandId: 'help' });
  },
});

// `/commands` is an alias for `/help` — register it as a separate entry that
// delegates to the help handler.
voiceCommandRegistry.register({
  id: 'commands',
  triggers: ['commands', 'list commands'],
  slashCommand: '/commands',
  category: 'core',
  description: 'Alias for /help — list all commands',
  uiCard: CommandHelpCard as unknown as React.ComponentType<{
    sessionId: string;
    onDismiss: () => void;
    context?: Record<string, unknown>;
  }>,
  handler: () => {
    voiceCommandEvents.emit({ type: 'push-card', commandId: 'help' });
  },
});

voiceCommandRegistry.register({
  id: 'clear-chat',
  triggers: ['clear chat', 'start over'],
  slashCommand: '/clear',
  category: 'core',
  description: 'Clear the chat display (keeps session)',
  handler: () => {
    voiceCommandEvents.emit({ type: 'clear-chat' });
  },
});

voiceCommandRegistry.register({
  id: 'new-chat',
  triggers: ['new chat', 'new conversation'],
  slashCommand: '/new',
  category: 'core',
  description: 'Start a new chat session',
  handler: () => {
    voiceCommandEvents.emit({ type: 'new-session' });
  },
});

voiceCommandRegistry.register({
  id: 'load-session',
  triggers: ['load session', 'open session', 'load skill'],
  slashCommand: '/load',
  category: 'core',
  description: 'Load a skill by name (e.g. /load brainstorming)',
  handler: ({ args }) => {
    if (!args) {
      voiceCommandEvents.emit({
        type: 'toast',
        level: 'error',
        message: '/load needs a skill name. Try: /load brainstorming',
      });
      return;
    }
    voiceCommandEvents.emit({ type: 'load-skill', skillName: args });
  },
});

voiceCommandRegistry.register({
  id: 'skills',
  triggers: ['show skills', 'list skills', 'search skills'],
  slashCommand: '/skills',
  category: 'core',
  description: 'Search available skills',
  handler: ({ args }) => {
    voiceCommandEvents.emit({ type: 'fetch-skills', query: args ?? '' });
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
  id: 'exam',
  triggers: ['start exam', 'open exam'],
  slashCommand: '/exam',
  category: 'core',
  description: 'Open exam mode for a topic or attached files',
  handler: ({ args }) => {
    voiceCommandEvents.emit({ type: 'open-exam', topic: args });
  },
});
