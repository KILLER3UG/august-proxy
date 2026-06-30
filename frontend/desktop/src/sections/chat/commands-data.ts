export interface ChatCommand {
  name: string;
  desc: string;
  usage?: string;
  example?: string;
  category?: string;
  voiceTriggers?: string[]; // v4 voice command UI (spec: 2026-06-30-voice-command-ui-infrastructure-design.md)
}

export const COMMANDS: ChatCommand[] = [
  { name: '/help', desc: 'Show available commands and capabilities', usage: '/help', example: '/help', category: 'Meta', voiceTriggers: ['help', 'show help', 'show commands', 'what can you do'] },
  { name: '/commands', desc: 'Alias for /help — list all commands', usage: '/commands', example: '/commands', category: 'Meta', voiceTriggers: ['commands', 'list commands'] },
  { name: '/clear', desc: 'Clear the chat display (keeps session)', usage: '/clear', example: '/clear', category: 'Session', voiceTriggers: ['clear', 'clear chat', 'clear screen'] },
  { name: '/new', desc: 'Start a new chat session', usage: '/new', example: '/new', category: 'Session', voiceTriggers: ['new', 'new chat', 'new session', 'start over'] },
  { name: '/reset', desc: 'Reset conversation history', usage: '/reset', example: '/reset', category: 'Session', voiceTriggers: ['reset', 'reset chat', 'reset history'] },
  { name: '/model', desc: 'Switch model for this session', usage: '/model <name>', example: '/model minimax-m2.7', category: 'Provider', voiceTriggers: ['model', 'switch model', 'change model', 'pick model'] },
  { name: '/provider', desc: 'Switch provider for this session', usage: '/provider <name>', example: '/provider MiniMax (Global)', category: 'Provider', voiceTriggers: ['provider', 'switch provider', 'change provider'] },
  { name: '/debug', desc: 'Toggle diagnostics mode (verbose tool traces)', usage: '/debug', example: '/debug', category: 'Workbench', voiceTriggers: ['debug', 'toggle debug', 'debug mode'] },
  { name: '/goal', desc: 'Set a workbench goal condition', usage: '/goal <condition>', example: '/goal All tests pass', category: 'Workbench', voiceTriggers: ['goal', 'set goal'] },
  { name: '/btw', desc: 'Ask a by-the-way question without losing context', usage: '/btw <question>', example: '/btw What does this codebase do?', category: 'Workbench', voiceTriggers: ['by the way', 'btw'] },
  { name: '/load', desc: 'Load a skill by name', usage: '/load <skill-name>', example: '/load brainstorming', category: 'Skills', voiceTriggers: ['load', 'load skill'] },
  { name: '/skills', desc: 'Search available skills', usage: '/skills [query]', example: '/skills testing', category: 'Skills', voiceTriggers: ['skills', 'search skills', 'show skills'] },
  { name: '/exam', desc: 'Open exam mode for a topic or attached files', usage: '/exam [topic]', example: '/exam python decorators', category: 'Study', voiceTriggers: ['exam', 'test me', 'quiz me', 'exam mode'] },
];
