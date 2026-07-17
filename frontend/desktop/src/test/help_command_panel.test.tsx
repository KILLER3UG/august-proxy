import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('/help in-thread panel (registry-based)', () => {
  it('built-in commands are registered in builtins.ts with desc/category fields', () => {
    const path = resolve(__dirname, '../api/voice/builtins.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/category:\s*['"]core['"]/);
    expect(src).toMatch(/description:/);
    expect(src).toMatch(/slashCommand:\s*['"]\/help['"]/);
  });

  it('/help injects a CommandHelpCard block via registry push-card event', () => {
    const path = resolve(__dirname, '../sections/chat/hooks/useChatVoiceCommands.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/voiceCommandRegistry|push-card|CommandHelpCard|help/);
    expect(src).not.toMatch(/toast\.info\([^)]*Available commands/s);
  });

  it('CommandHelpCard reads from the registry (not commands-data.ts)', () => {
    const path = resolve(__dirname, '../sections/chat/CommandHelpCard.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/getDisplayCommands|from\s*['"]@\/api\/voice\/registry['"]/);
    expect(src).not.toMatch(/from\s*['"]\.\/commands-data['"]/);
  });

  it('MessageBubble renders CommandHelpCard when kind:help', () => {
    const path = resolve(__dirname, '../sections/chat/MessageBubble.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/CommandHelpCard/);
  });

  it('MessageBubble imports CommandHelpCard from ./CommandHelpCard', () => {
    const path = resolve(__dirname, '../sections/chat/MessageBubble.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(
      /import\s*\{[^}]*CommandHelpCard[^}]*\}\s*from\s*['"]\.\/CommandHelpCard['"]/,
    );
  });
});
