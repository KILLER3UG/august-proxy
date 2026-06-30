/**
 * Voice command dispatcher — Routes matched voice intents to UI actions.
 * 
 * Spec: docs/superpowers/specs/2026-06-30-voice-command-ui-infrastructure-design.md
 * 
 * Usage:
 *   const cmd = matchIntent(transcript, COMMANDS);
 *   if (cmd) dispatchVoiceCommand(cmd, transcript, context);
 */

import type { ChatCommand } from '@/sections/chat/commands-data';

export interface VoiceDispatchContext {
  /** Show the inline model picker card */
  onShowModelPicker?: () => void;
  /** Insert text into composer */
  onInsertText?: (text: string) => void;
  /** Send a message immediately */
  onSendMessage?: (text: string) => void;
  /** Clear chat */
  onClearChat?: () => void;
  /** Start new session */
  onNewSession?: () => void;
  /** Reset session */
  onResetSession?: () => void;
  /** Toggle debug mode */
  onToggleDebug?: () => void;
  /** Show help */
  onShowHelp?: () => void;
  /** Show skills */
  onShowSkills?: () => void;
  /** Open exam mode */
  onOpenExam?: (topic?: string) => void;
}

export interface DispatchResult {
  handled: boolean;
  action: 'ui' | 'insert' | 'send' | 'fallthrough';
  detail?: string;
}

/**
 * Dispatch a matched voice command to the appropriate UI handler.
 * 
 * Strategy:
 * - UI commands (e.g., /model) trigger inline cards/panels
 * - Argument-taking commands (e.g., /goal X) insert into composer for user review
 * - Stateless commands (e.g., /clear) execute immediately
 * - Unmatched commands fall through to composer (dictation)
 */
export function dispatchVoiceCommand(
  command: ChatCommand,
  transcript: string,
  context: VoiceDispatchContext
): DispatchResult {
  switch (command.name) {
    case '/model':
      if (context.onShowModelPicker) {
        context.onShowModelPicker();
        return { handled: true, action: 'ui', detail: 'Opened model picker' };
      }
      break;

    case '/help':
    case '/commands':
      if (context.onShowHelp) {
        context.onShowHelp();
        return { handled: true, action: 'ui', detail: 'Showed help' };
      }
      break;

    case '/clear':
      if (context.onClearChat) {
        context.onClearChat();
        return { handled: true, action: 'ui', detail: 'Cleared chat' };
      }
      break;

    case '/new':
      if (context.onNewSession) {
        context.onNewSession();
        return { handled: true, action: 'ui', detail: 'Started new session' };
      }
      break;

    case '/reset':
      if (context.onResetSession) {
        context.onResetSession();
        return { handled: true, action: 'ui', detail: 'Reset session' };
      }
      break;

    case '/debug':
      if (context.onToggleDebug) {
        context.onToggleDebug();
        return { handled: true, action: 'ui', detail: 'Toggled debug mode' };
      }
      break;

    case '/skills':
      if (context.onShowSkills) {
        context.onShowSkills();
        return { handled: true, action: 'ui', detail: 'Showed skills' };
      }
      break;

    case '/exam': {
      // Extract topic from transcript after the trigger word
      const topic = extractArgument(transcript, command.voiceTriggers || []);
      if (context.onOpenExam) {
        context.onOpenExam(topic);
        return { handled: true, action: 'ui', detail: `Opened exam${topic ? `: ${topic}` : ''}` };
      }
      break;
    }

    case '/goal':
    case '/btw':
    case '/load':
    case '/provider': {
      // Commands that need user review: insert into composer
      const arg = extractArgument(transcript, command.voiceTriggers || []);
      const text = arg ? `${command.name} ${arg}` : `${command.name} `;
      if (context.onInsertText) {
        context.onInsertText(text);
        return { handled: true, action: 'insert', detail: `Inserted: ${text}` };
      }
      break;
    }
  }

  return { handled: false, action: 'fallthrough' };
}

/**
 * Extract the argument from a transcript by removing the matched trigger phrase.
 * 
 * Example:
 *   extractArgument("exam python decorators", ["exam", "test me"]) → "python decorators"
 */
function extractArgument(transcript: string, triggers: string[]): string {
  const lower = transcript.toLowerCase().trim();
  
  // Sort triggers by length (longest first) to avoid partial matches
  const sortedTriggers = [...triggers].sort((a, b) => b.length - a.length);
  
  for (const trigger of sortedTriggers) {
    const triggerLower = trigger.toLowerCase();
    if (lower.startsWith(triggerLower)) {
      return transcript.slice(triggerLower.length).trim();
    }
    // Also check for trigger anywhere in the first 3 words
    const idx = lower.indexOf(triggerLower);
    if (idx !== -1 && idx < 20) {
      return transcript.slice(idx + triggerLower.length).trim();
    }
  }
  
  return '';
}
