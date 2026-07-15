import { describe, it, expect } from 'vitest';
import { buildTurnRecap } from '../turn-recap';
import type { MessageBlock } from '@/types/chat';

function tool(
  name: string,
  context: Record<string, unknown>,
  id = name,
): MessageBlock {
  return {
    id,
    type: 'toolCall',
    tool: {
      id,
      name,
      status: 'done',
      context: JSON.stringify(context),
    },
  };
}

describe('buildTurnRecap', () => {
  it('returns null for empty activity', () => {
    expect(buildTurnRecap({ finalText: 'Hello there.' })).toBeNull();
  });

  it('summarizes reads, edits, and commands', () => {
    const text = buildTurnRecap({
      blocks: [
        tool('read_file', { path: 'src/a.ts' }, '1'),
        tool('read_file', { path: 'src/b.ts' }, '2'),
        tool('write_file', { path: 'src/a.ts' }, '3'),
        tool('run_command', { command: 'npm test' }, '4'),
      ],
    });
    expect(text).toMatch(/^We /);
    expect(text).toMatch(/read/i);
    expect(text).toMatch(/edited/i);
    expect(text).toMatch(/ran/i);
    expect(text).toMatch(/npm/);
  });

  it('includes changed files on disk', () => {
    const text = buildTurnRecap({
      blocks: [tool('bash', { command: 'echo hi' }, '1')],
      changedFiles: {
        files: [{ path: 'docs/plan.md', added: 10, removed: 0 }],
      },
    });
    expect(text).toMatch(/ran/);
    expect(text).toMatch(/plan\.md|files on disk|updated/);
  });

  it('handles only file edits via changedFiles', () => {
    const text = buildTurnRecap({
      changedFiles: {
        files: [
          { path: 'foo.ts', added: 1, removed: 0 },
          { path: 'bar.ts', added: 2, removed: 1 },
        ],
      },
    });
    expect(text).toMatch(/^We /);
    expect(text).toMatch(/foo\.ts|bar\.ts|2 files|edited|updated/);
  });
});
