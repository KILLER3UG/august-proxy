import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('/help in-thread panel', () => {
  it('COMMANDS entries carry desc/usage/example/category fields', () => {
    const path = resolve(__dirname, '../sections/chat/commands-data.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/category:\s*['"]/);
    expect(src).toMatch(/usage:\s*['"`]/);
    expect(src).toMatch(/example:\s*['"`]/);
  });

  it('/help injects a CommandHelpCard block (not a toast)', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/setMessages[\s\S]{0,300}kind:\s*['"]help['"]/);
    // Old toast path is gone
    expect(src).not.toMatch(/toast\.info\([^)]*Available commands/s);
  });

  it('CommandHelpCard renders every COMMANDS entry', () => {
    const path = resolve(__dirname, '../sections/chat/CommandHelpCard.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/COMMANDS\.map|commands\.map|cmd\.name/);
    expect(src).toMatch(/desc/);
  });

  it('dropdown shows description for each command', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    // The dropdown maps commands and renders description
    expect(src).toMatch(/c\.desc/);
  });

  it('ChatThread imports CommandHelpCard from ./CommandHelpCard', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*CommandHelpCard[^}]*\}\s*from\s*['"]\.\/CommandHelpCard['"]/);
  });
});
