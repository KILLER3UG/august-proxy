import { describe, it, expect } from 'vitest';
import { classifyTool, normalizeToolName } from '../tool-classify';

describe('normalizeToolName', () => {
  it('strips prefixes and lowercases', () => {
    expect(normalizeToolName('august__read_file')).toBe('read_file');
    expect(normalizeToolName('workbench_run_command')).toBe('run_command');
    expect(normalizeToolName('@run_command')).toBe('run_command');
    expect(normalizeToolName('default_api:view_file')).toBe('view_file');
    expect(normalizeToolName('AUGUST__Grep')).toBe('grep');
  });
});

describe('classifyTool', () => {
  it('classifies view tools', () => {
    expect(classifyTool('read_file')).toBe('view');
    expect(classifyTool('august__read_file')).toBe('view');
    expect(classifyTool('grep')).toBe('view');
    expect(classifyTool('august__list_dir')).toBe('view');
    expect(classifyTool('web_search')).toBe('view');
    expect(classifyTool('web_fetch')).toBe('view');
    expect(classifyTool('memory_search')).toBe('view');
  });

  it('classifies edit tools', () => {
    expect(classifyTool('write_file')).toBe('edit');
    expect(classifyTool('august__edit_file')).toBe('edit');
    expect(classifyTool('apply_patch')).toBe('edit');
    expect(classifyTool('str_replace')).toBe('edit');
    expect(classifyTool('delete_file')).toBe('edit');
    expect(classifyTool('@create_file')).toBe('edit');
  });

  it('classifies run tools', () => {
    expect(classifyTool('run_command')).toBe('run');
    expect(classifyTool('@run_command')).toBe('run');
    expect(classifyTool('august__bash')).toBe('run');
    expect(classifyTool('bash')).toBe('run');
    expect(classifyTool('workbench_run_command')).toBe('run');
  });

  it('defaults unknown tools to tool', () => {
    expect(classifyTool('august__spawn_subagent')).toBe('tool');
    expect(classifyTool('setup_provider')).toBe('tool');
    expect(classifyTool('remember')).toBe('tool');
    expect(classifyTool('weird_custom_thing')).toBe('tool');
  });
});
