/* v3 — /Exam slash command is registered in ChatThread */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('v3 — /Exam slash command registration', () => {
  it('commands-data registers /exam in the COMMANDS list', () => {
    // COMMANDS now lives in commands-data.ts (extracted from ChatThread in Task 10).
    const path = resolve(__dirname, '../sections/chat/commands-data.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/name:\s*'\/exam'/);
  });

  it('ChatThread dispatches /exam to open the ExamHost overlay', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/cmd === ['"]exam['"]/);
    expect(src).toMatch(/setExamActive\(true\)/);
  });

  it('ChatThread imports ExamHost and renders it when examActive', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/import\s*\{\s*ExamHost\s*\}\s*from\s*['"]@\/sections\/exam\/ExamHost['"]/);
    expect(src).toMatch(/\{examActive\s*&&/);
    expect(src).toMatch(/<ExamHost\s/);
  });
});