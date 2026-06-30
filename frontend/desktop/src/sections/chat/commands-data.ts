export interface ChatCommand {
  name: string;
  desc: string;
  usage?: string;
  example?: string;
  category?: string;
}

export const COMMANDS: ChatCommand[] = [
  { name: '/help', desc: 'Show available commands and capabilities', usage: '/help', example: '/help', category: 'Meta' },
  { name: '/commands', desc: 'Alias for /help — list all commands', usage: '/commands', example: '/commands', category: 'Meta' },
  { name: '/clear', desc: 'Clear the chat display (keeps session)', usage: '/clear', example: '/clear', category: 'Session' },
  { name: '/new', desc: 'Start a new chat session', usage: '/new', example: '/new', category: 'Session' },
  { name: '/reset', desc: 'Reset conversation history', usage: '/reset', example: '/reset', category: 'Session' },
  { name: '/model', desc: 'Switch model for this session', usage: '/model <name>', example: '/model minimax-m2.7', category: 'Provider' },
  { name: '/provider', desc: 'Switch provider for this session', usage: '/provider <name>', example: '/provider MiniMax (Global)', category: 'Provider' },
  { name: '/debug', desc: 'Toggle diagnostics mode (verbose tool traces)', usage: '/debug', example: '/debug', category: 'Workbench' },
  { name: '/goal', desc: 'Set a workbench goal condition', usage: '/goal <condition>', example: '/goal All tests pass', category: 'Workbench' },
  { name: '/btw', desc: 'Ask a by-the-way question without losing context', usage: '/btw <question>', example: '/btw What does this codebase do?', category: 'Workbench' },
  { name: '/load', desc: 'Load a skill by name', usage: '/load <skill-name>', example: '/load brainstorming', category: 'Skills' },
  { name: '/skills', desc: 'Search available skills', usage: '/skills [query]', example: '/skills testing', category: 'Skills' },
  { name: '/exam', desc: 'Open exam mode for a topic or attached files', usage: '/exam [topic]', example: '/exam python decorators', category: 'Study' },
];
