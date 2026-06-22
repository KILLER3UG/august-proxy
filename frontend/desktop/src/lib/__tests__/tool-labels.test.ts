import { describe, it, expect } from 'vitest';
import { getToolLabel } from '../tool-labels';

describe('getToolLabel mapping and cleaning', () => {
  it('maps standard tool names correctly', () => {
    expect(getToolLabel('august_read')).toBe('Reading');
    expect(getToolLabel('august_read', { status: 'done' })).toBe('Read');
    expect(getToolLabel('august_bash', { status: 'running' })).toBe('Running');
    expect(getToolLabel('august_bash', { status: 'done' })).toBe('Ran');
    expect(getToolLabel('august_write')).toBe('Writing');
    expect(getToolLabel('august_write', { status: 'done' })).toBe('Wrote');
    expect(getToolLabel('august_search')).toBe('Searching');
    expect(getToolLabel('august_search', { status: 'done' })).toBe('Searched');
    expect(getToolLabel('august_edit')).toBe('Editing');
    expect(getToolLabel('august_delete')).toBe('Deleting');
    expect(getToolLabel('august_memory_write', { status: 'running' })).toBe('Saving memory');
    expect(getToolLabel('august_memory_write', { status: 'done' })).toBe('Saved memory');
    expect(getToolLabel('august_web')).toBe('Fetching');
    expect(getToolLabel('august_api')).toBe('Calling API');
  });

  it('cleans namespaces before lookup', () => {
    expect(getToolLabel('default_api:run_command', { status: 'running' })).toBe('Running');
    expect(getToolLabel('default_api:view_file')).toBe('Reading');
    expect(getToolLabel('default_api:replace_file_content')).toBe('Editing');
    expect(getToolLabel('default_api:multi_replace_file_content')).toBe('Editing');
    expect(getToolLabel('default_api:write_to_file')).toBe('Writing');
  });

  it('formats subagent tool calls with agent role', () => {
    expect(getToolLabel('invoke_subagent', { agentId: 'explore' })).toBe('Delegating • Explore');
    expect(getToolLabel('invoke_subagent', { agentId: 'explore', status: 'done' })).toBe('Delegated • Explore');
    expect(getToolLabel('august__spawn_subagent', { agentId: 'plan' })).toBe('Delegating • Plan');
    expect(getToolLabel('invoke_subagent')).toBe('Delegating');
    expect(getToolLabel('invoke_subagent', { status: 'done' })).toBe('Delegated');
  });

  it('formats command executions with context-aware command', () => {
    expect(getToolLabel('run_command', { command: 'git status', status: 'running' })).toBe('Running: git status');
    expect(getToolLabel('run_command', { command: 'git status', status: 'done' })).toBe('Ran: git status');
  });

  it('falls back to title cased names for unknown tools', () => {
    expect(getToolLabel('default_api:some_unknown_tool', { status: 'running' })).toBe('Some Unknown Tool');
    expect(getToolLabel('default_api:some_unknown_tool', { status: 'done' })).toBe('Some Unknown Tool');
    expect(getToolLabel('august__another_tool', { status: 'running' })).toBe('Another Tool');
    expect(getToolLabel('workbench_my_custom_action', { status: 'running' })).toBe('My Custom Action');
  });
});
