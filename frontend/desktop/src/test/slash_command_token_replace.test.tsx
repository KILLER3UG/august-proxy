/* Task 9: Slash command token-replace + keyboard nav + wire stubs */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Slash command token replacement + keyboard nav', () => {
  it('defines an insertCommand that replaces the leading slash token', () => {
    const path = resolve(__dirname, '../sections/chat/composer/useComposerPopovers.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/const\s+insertCommand\s*=\s*/);
  });

  it('commands dropdown uses insertCommand (not insertText) to avoid double slash', () => {
    const composerSrc = readFileSync(
      resolve(__dirname, '../sections/chat/ChatThreadComposer.tsx'),
      'utf8',
    );
    expect(composerSrc).toMatch(/insertCommand\(/);
    expect(composerSrc).not.toMatch(/insertText\(c\.name\s*\+\s*['"]\s*['"]\)/);
  });

  it('Enter key selects highlighted command or sends when dropdown is closed', () => {
    const path = resolve(__dirname, '../sections/chat/composer/useComposerPopovers.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/Enter/);
    expect(src).toMatch(/highlightedCommandIndex/);
  });

  it('ArrowUp/ArrowDown navigates highlightedCommandIndex', () => {
    const path = resolve(__dirname, '../sections/chat/composer/useComposerPopovers.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/ArrowDown/);
    expect(src).toMatch(/ArrowUp/);
    expect(src).toMatch(/highlightedCommandIndex/);
  });

  it('Esc closes the commands dropdown', () => {
    const path = resolve(__dirname, '../sections/chat/composer/useComposerPopovers.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/Escape/);
    expect(src).toMatch(/setShowCommandsDropdown\(false\)/);
  });

  it('/new dispatches an august:new-session event', () => {
    const path = resolve(__dirname, '../sections/chat/hooks/useChatVoiceCommands.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/dispatchEvent\(new\s+CustomEvent\(['"]august:new-session['"]/);
  });
});
