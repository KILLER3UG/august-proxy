/* Task 9: Slash command token-replace + keyboard nav + wire stubs */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Slash command token replacement + keyboard nav', () => {
  it('defines an insertCommand that replaces the leading slash token', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/const\s+insertCommand\s*=\s*\(/);
  });

  it('commands dropdown uses insertCommand (not insertText) to avoid double slash', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    // Find the dropdown button onClick — should call insertCommand, not insertText(name + ' ')
    expect(src).toMatch(/onClick=\{?\(\)\s*=>\s*\{?\s*insertCommand\(c\.name/);
    expect(src).not.toMatch(/insertText\(c\.name\s*\+\s*['"]\s*['"]\)/);
  });

  it('Enter key selects highlighted command or sends when dropdown is closed', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/Enter.*highlightedCommandIndex|highlightedCommandIndex.*Enter/);
  });

  it('ArrowUp/ArrowDown navigates highlightedCommandIndex', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/ArrowDown.*highlightedCommandIndex\s*=|highlightedCommandIndex\s*=.*ArrowDown/);
    expect(src).toMatch(/ArrowUp.*highlightedCommandIndex\s*=|highlightedCommandIndex\s*=.*ArrowUp/);
  });

  it('Esc closes the commands dropdown', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/Escape.*setShowCommandsDropdown\(false\)|setShowCommandsDropdown\(false\)[\s\S]{0,40}Escape/);
  });

  it('/new dispatches an august:new-session event', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/dispatchEvent\(new\s+CustomEvent\(['"]august:new-session['"]/);
  });
});
