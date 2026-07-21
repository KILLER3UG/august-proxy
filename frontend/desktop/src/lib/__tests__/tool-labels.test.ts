import { describe, it, expect } from 'vitest';
import { getToolLabel, pathBasename } from '../tool-labels';

describe('getToolLabel mapping and cleaning', () => {
  it('maps canonical tool names correctly', () => {
    expect(getToolLabel('read')).toBe('Reading');
    expect(getToolLabel('read', { status: 'done' })).toBe('Read');
    expect(getToolLabel('bash', { status: 'running' })).toBe('Running');
    expect(getToolLabel('bash', { status: 'done' })).toBe('Ran');
    expect(getToolLabel('write')).toBe('Writing');
    expect(getToolLabel('write', { status: 'done' })).toBe('Wrote');
    expect(getToolLabel('search')).toBe('Searching');
    expect(getToolLabel('search', { status: 'done' })).toBe('Searched');
    expect(getToolLabel('edit')).toBe('Editing');
    expect(getToolLabel('delete')).toBe('Deleting');
    expect(getToolLabel('memory_write', { status: 'running' })).toBe('Saving memory');
    expect(getToolLabel('memory_write', { status: 'done' })).toBe('Saved memory');
    expect(getToolLabel('web')).toBe('Fetching');
    expect(getToolLabel('api')).toBe('Calling API');
    expect(getToolLabel('grep')).toBe('Searching files');
  });

  it('looks up labels by canonical tool name', () => {
    expect(getToolLabel('read')).toBe('Reading');
    expect(getToolLabel('grep')).toBe('Searching files');
    expect(getToolLabel('system_info')).toBe('Reading system info');
    expect(getToolLabel('run_command', { status: 'running' })).toBe('Running');
    expect(getToolLabel('view_file')).toBe('Reading');
    expect(getToolLabel('replace_file_content')).toBe('Editing');
    expect(getToolLabel('multi_replace_file_content')).toBe('Editing');
    expect(getToolLabel('write_to_file')).toBe('Writing');
  });

  it('formats subagent tool calls with agent role', () => {
    expect(getToolLabel('invoke_subagent', { agentId: 'explore' })).toBe('Delegating • Explore');
    expect(getToolLabel('invoke_subagent', { agentId: 'explore', status: 'done' })).toBe('Delegated • Explore');
    expect(getToolLabel('spawn_subagent', { agentId: 'plan' })).toBe('Delegating • Plan');
    expect(getToolLabel('invoke_subagent')).toBe('Delegating');
    expect(getToolLabel('invoke_subagent', { status: 'done' })).toBe('Delegated');
  });

  it('formats command executions with context-aware command', () => {
    expect(getToolLabel('run_command', { command: 'git status', status: 'running' })).toBe('Running: git status');
    expect(getToolLabel('run_command', { command: 'git status', status: 'done' })).toBe('Ran: git status');
  });

  it('includes file/dir basename on read and list labels', () => {
    expect(getToolLabel('read_file', { filename: 'README.md', status: 'running' })).toBe(
      'Reading README.md',
    );
    expect(getToolLabel('read_file', { filename: 'src/app.ts', status: 'done' })).toBe(
      'Read app.ts',
    );
    expect(
      getToolLabel('read_file', {
        filename: 'C:/Dev/Agentic-Trading/backend/ai/app/paths.py',
        status: 'done',
      }),
    ).toBe('Read paths.py');
    expect(
      getToolLabel('read_file', {
        filename: 'C:\\Dev\\Agentic-Trading\\frontend\\src\\hooks\\useWebSocket.ts',
        status: 'done',
      }),
    ).toBe('Read useWebSocket.ts');
    expect(getToolLabel('list_directory', { filename: 'backend-py/app', status: 'running' })).toBe(
      'Listing app',
    );
    expect(getToolLabel('list_dir', { filename: 'C:/Dev/Agentic-Trading', status: 'done' })).toBe(
      'Listed Agentic-Trading',
    );
  });

  it('pathBasename strips directories and handles both separators', () => {
    expect(pathBasename('C:/Dev/Agentic-Trading/backend/ai/app/paths.py')).toBe('paths.py');
    expect(pathBasename('C:\\Dev\\Agentic-Trading')).toBe('Agentic-Trading');
    expect(pathBasename('src/app.ts')).toBe('app.ts');
    expect(pathBasename('README.md')).toBe('README.md');
    expect(pathBasename('C:/Dev/Agentic-Trading/')).toBe('Agentic-Trading');
  });

  it('falls back to title cased names for unknown tools', () => {
    expect(getToolLabel('default_api:some_unknown_tool', { status: 'running' })).toBe('Some Unknown Tool');
    expect(getToolLabel('default_api:some_unknown_tool', { status: 'done' })).toBe('Some Unknown Tool');
    expect(getToolLabel('another_tool', { status: 'running' })).toBe('Another Tool');
    expect(getToolLabel('my_custom_action', { status: 'running' })).toBe('My Custom Action');
  });

  it('humanizes the system / diagnostic / agent / activity tool set', () => {
    expect(getToolLabel('system_info')).toBe('Reading system info');
    expect(getToolLabel('describe_environment')).toBe('Describing environment');
    expect(getToolLabel('diagnose_proxy')).toBe('Diagnosing proxy');
    expect(getToolLabel('list_proxy_capabilities')).toBe('Listing capabilities');
    expect(getToolLabel('list_agent_registry')).toBe('Listing agents');
    expect(getToolLabel('list_agent_jobs')).toBe('Listing jobs');
    expect(getToolLabel('get_agent_job')).toBe('Fetching job');
    expect(getToolLabel('get_activity')).toBe('Reading activity');

    expect(getToolLabel('system_info', { status: 'done' })).toBe('Read system info');
    expect(getToolLabel('describe_environment', { status: 'done' })).toBe('Described environment');
    expect(getToolLabel('diagnose_proxy', { status: 'done' })).toBe('Diagnosed proxy');
    expect(getToolLabel('list_proxy_capabilities', { status: 'done' })).toBe('Listed capabilities');
    expect(getToolLabel('list_agent_registry', { status: 'done' })).toBe('Listed agents');
    expect(getToolLabel('list_agent_jobs', { status: 'done' })).toBe('Listed jobs');
    expect(getToolLabel('get_agent_job', { status: 'done' })).toBe('Fetched job');
    expect(getToolLabel('get_activity', { status: 'done' })).toBe('Read activity');
  });
});
