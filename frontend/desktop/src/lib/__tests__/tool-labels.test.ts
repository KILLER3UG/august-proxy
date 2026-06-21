import { describe, it, expect } from 'vitest';
import { getToolLabel } from '../tool-labels';

describe('getToolLabel mapping and cleaning', () => {
  it('maps standard tool names correctly', () => {
    expect(getToolLabel('august_read')).toBe('Reading file');
    expect(getToolLabel('august_bash', { status: 'running' })).toBe('Executing command');
    expect(getToolLabel('august_write')).toBe('Writing file');
    expect(getToolLabel('august_search')).toBe('Searching');
    expect(getToolLabel('august_edit')).toBe('Editing file');
    expect(getToolLabel('august_delete')).toBe('Deleting file');
    expect(getToolLabel('august_memory_write')).toBe('Updating memory');
    expect(getToolLabel('august_web')).toBe('Web request');
    expect(getToolLabel('august_api')).toBe('API call');
  });

  it('cleans namespaces before lookup', () => {
    expect(getToolLabel('default_api:run_command', { status: 'running' })).toBe('Executing command');
    expect(getToolLabel('default_api:view_file')).toBe('Reading file');
    expect(getToolLabel('default_api:replace_file_content')).toBe('Editing file');
    expect(getToolLabel('default_api:multi_replace_file_content')).toBe('Editing file');
    expect(getToolLabel('default_api:write_to_file')).toBe('Writing file');
  });

  it('formats subagent tool calls with agent role', () => {
    expect(getToolLabel('invoke_subagent', { agentId: 'explore' })).toBe('Subagent • Explore');
    expect(getToolLabel('august__spawn_subagent', { agentId: 'plan' })).toBe('Subagent • Plan');
    expect(getToolLabel('invoke_subagent')).toBe('Subagent');
  });

  it('formats command executions with context-aware command', () => {
    expect(getToolLabel('run_command', { command: 'git status', status: 'running' })).toBe('Executing command: git status');
    expect(getToolLabel('run_command', { command: 'git status', status: 'done' })).toBe('Executed command: git status');
  });

  it('falls back to title cased names for unknown tools', () => {
    expect(getToolLabel('default_api:some_unknown_tool')).toBe('Some Unknown Tool');
    expect(getToolLabel('august__another_tool')).toBe('Another Tool');
    expect(getToolLabel('workbench_my_custom_action')).toBe('My Custom Action');
  });
});
