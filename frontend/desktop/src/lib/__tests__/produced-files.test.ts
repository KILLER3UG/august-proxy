import { describe, it, expect } from 'vitest';
import { collectProducedFiles, producedFileLabel } from '../produced-files';
import type { MessageBlock } from '@/types/chat';

function editTool(name: string, context: Record<string, unknown>, id = name): MessageBlock {
  return {
    id,
    type: 'toolCall',
    tool: { id, name, context: JSON.stringify(context), status: 'done' },
  };
}

describe('collectProducedFiles', () => {
  it('collects unique file paths from edit-classified tool calls', () => {
    const blocks = [
      editTool('write_file', { file_path: 'src/a.ts' }),
      editTool('apply_patch', { filePath: 'src/b.ts' }),
      editTool('edit_file', { path: 'src/a.ts' }), // dup — dropped
    ];
    expect(collectProducedFiles(blocks)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('ignores non-edit tools and tools without a file path', () => {
    const blocks = [
      editTool('read_file', { path: 'src/read.ts' }), // view, not edit
      editTool('run_command', { command: 'npm test' }), // run
      editTool('update_state', { phase: 'complete' }), // edit bucket but no path
    ];
    expect(collectProducedFiles(blocks)).toEqual([]);
  });

  it('excludes .aug internal bookkeeping paths', () => {
    const blocks = [
      editTool('write_file', { file_path: '.aug/plans/abc.md' }),
      editTool('write_file', { file_path: 'src/ok.ts' }),
    ];
    expect(collectProducedFiles(blocks)).toEqual(['src/ok.ts']);
  });

  it('handles Windows-style paths and empty input', () => {
    expect(collectProducedFiles(null)).toEqual([]);
    const blocks = [editTool('write_file', { file_path: 'C:\\repo\\src\\x.ts' })];
    expect(collectProducedFiles(blocks)).toEqual(['C:\\repo\\src\\x.ts']);
  });
});

describe('producedFileLabel', () => {
  it('returns the basename and falls back to the path', () => {
    expect(producedFileLabel('src/components/a.ts')).toBe('a.ts');
    expect(producedFileLabel('C:\\repo\\src\\x.ts')).toBe('x.ts');
    expect(producedFileLabel('weird')).toBe('weird');
  });
});
