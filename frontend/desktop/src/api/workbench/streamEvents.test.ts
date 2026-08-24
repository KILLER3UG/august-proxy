/* Dispatcher tests for workbench/streamEvents — toolResult error mapping
 * (backend sends `status`, never `isError`) and the formerly-dead event
 * cases (memoryUpdated / subagentRetry / subagentWarning / evidenceState /
 * modelProfileSuggestion). */
import { describe, it, expect, vi } from 'vitest';
import { dispatchWorkbenchEvent } from './streamEvents';
import type { WorkbenchEventHandlers } from '@/types/workbench';

describe('toolResult error mapping', () => {
  it('treats status !== "done" as an error (backend sends status, never isError)', () => {
    const onToolResult = vi.fn();
    dispatchWorkbenchEvent(
      'toolResult',
      { id: 't1', name: 'run_command', content: 'ls: cannot access', status: 'failed' },
      { onToolResult },
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', isError: true, status: 'failed' }),
    );
  });

  it('treats Error:-prefixed content as an error even when status is missing', () => {
    const onToolResult = vi.fn();
    dispatchWorkbenchEvent(
      'toolResult',
      { id: 't2', name: 'web_search', content: 'Error: upstream 429 rate limited' },
      { onToolResult },
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't2', isError: true }),
    );
  });

  it('treats status "done" as success', () => {
    const onToolResult = vi.fn();
    dispatchWorkbenchEvent(
      'toolResult',
      { id: 't3', name: 'grep', content: 'matched', status: 'done' },
      { onToolResult },
    );
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't3', isError: false, status: 'done' }),
    );
  });

  it('subagentToolResult: backend status pass-through with error coercion', () => {
    const onSubagentToolResult = vi.fn();
    dispatchWorkbenchEvent(
      'subagentToolResult',
      { jobId: 'j1', agentId: 'researcher', id: 'st1', name: 'grep', content: 'boom', status: 'error' },
      { onSubagentToolResult },
    );
    expect(onSubagentToolResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'j1', id: 'st1', isError: true, status: 'error' }),
    );
  });
});

describe('previously-undispatched backend events', () => {
  it('subagentRetry dispatches onSubagentRetry with backoff numbers', () => {
    const onSubagentRetry = vi.fn();
    dispatchWorkbenchEvent(
      'subagentRetry',
      { jobId: 'j1', agentId: 'researcher', attempt: 2, maxRetries: 3, message: 'Transient upstream error — retrying in 4000ms' },
      { onSubagentRetry },
    );
    expect(onSubagentRetry).toHaveBeenCalledWith({
      jobId: 'j1',
      attempt: 2,
      maxRetries: 3,
      message: 'Transient upstream error — retrying in 4000ms',
    });
  });

  it('subagentWarning routes through onWarning (no dedicated nested handler)', () => {
    const onWarning = vi.fn();
    dispatchWorkbenchEvent(
      'subagentWarning',
      { jobId: 'j1', agentId: 'researcher', message: 'Sub-agent narrated a tool call instead of emitting it' },
      { onWarning },
    );
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'j1', message: 'Sub-agent narrated a tool call instead of emitting it' }),
    );
  });

});
