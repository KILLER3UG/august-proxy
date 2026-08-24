import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('/help in-thread panel (registry-based)', () => {
  const readSrc = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

  it('built-in commands are registered in builtins.ts with desc/category fields', () => {
    // 0.17.0: the composer surface is intentionally tiny — /compact, /init,
    // /btw, /goal. The /help panel reads whatever the registry holds, so the
    // assertion tracks the trimmed core set instead of a removed /help entry.
    const src = readSrc('../api/voice/builtins.ts');
    expect(src).toMatch(/category:\s*['"]core['"]/);
    expect(src).toMatch(/description:/);
    expect(src).toMatch(/slashCommand:\s*['"]\/compact['"]/);
    expect(src).toMatch(/slashCommand:\s*['"]\/goal['"]/);
  });

  it('/help panel renders from the registry (not commands-data.ts)', () => {
    const src = readSrc('../sections/chat/hooks/useChatVoiceCommands.ts');
    expect(src).toMatch(/voiceCommandRegistry|push-card|CommandHelpCard|help/);
    expect(src).not.toMatch(/toast\.info\([^)]*Available commands/s);
  });

  it('CommandHelpCard reads from the registry (not commands-data.ts)', () => {
    const src = readSrc('../sections/chat/CommandHelpCard.tsx');
    expect(src).toMatch(/getDisplayCommands|from\s*['"]@\/api\/voice\/registry['"]/);
    expect(src).not.toMatch(/from\s*['"]\.\/commands-data['"]/);
  });

  it('MessageBubble renders CommandHelpCard when kind:help', () => {
    const src = readSrc('../sections/chat/MessageBubble.tsx');
    expect(src).toMatch(/CommandHelpCard/);
  });

  it('MessageBubble imports CommandHelpCard from ./CommandHelpCard', () => {
    const src = readSrc('../sections/chat/MessageBubble.tsx');
    expect(src).toMatch(
      /import\s*\{[^}]*CommandHelpCard[^}]*\}\s*from\s*['"]\.\/CommandHelpCard['"]/,
    );
  });
});
