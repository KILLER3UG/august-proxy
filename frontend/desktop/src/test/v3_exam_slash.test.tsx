/* v3 — /Exam slash command is registered via the voice registry */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('v3 — /Exam slash command registration', () => {
  it('builtins.ts registers /exam in the voice command registry', () => {
    const path = resolve(__dirname, '../api/voice/builtins.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/id:\s*['"]exam['"]/);
    expect(src).toMatch(/slashCommand:\s*['"]\/exam['"]/);
    expect(src).toMatch(/open-exam/);
  });

  it('ChatThread emits an open-exam event when the registry runs the /exam handler', () => {
    const path = resolve(__dirname, '../sections/chat/hooks/useChatVoiceCommands.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/open-exam|setExamActive\(true\)/);
  });

  it('ChatThread imports ExamHost and renders it when examActive', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(
      /import\s*\{\s*ExamHost\s*\}\s*from\s*['"]@\/sections\/exam\/ExamHost['"]/,
    );
    expect(src).toMatch(/\{examActive\s*&&/);
    expect(src).toMatch(/<ExamHost\s/);
  });
});
