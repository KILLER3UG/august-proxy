/* The `retrying` SSE event parses into onRetrying with sane numbers. */
import { describe, it, expect, vi } from 'vitest';
import { dispatchWorkbenchEvent } from '@/api/workbench/streamEvents';
import type { WorkbenchEventHandlers } from '@/types/workbench';

describe('retrying event dispatch', () => {
  it('parses attempt/maxRetries/delayMs/reason', () => {
    const onRetrying = vi.fn();
    const handlers: WorkbenchEventHandlers = { onRetrying };

    dispatchWorkbenchEvent(
      'retrying',
      { attempt: 3, maxRetries: 10, delayMs: 8000, reason: '[429] Provider rate limit exceeded' },
      handlers,
    );

    expect(onRetrying).toHaveBeenCalledWith({
      attempt: 3,
      maxRetries: 10,
      delayMs: 8000,
      reason: '[429] Provider rate limit exceeded',
    });
  });

  it('coerces missing numbers to zero and reason to a fallback', () => {
    const onRetrying = vi.fn();
    dispatchWorkbenchEvent('retrying', {}, { onRetrying });
    expect(onRetrying).toHaveBeenCalledWith({
      attempt: 0,
      maxRetries: 0,
      delayMs: 0,
      reason: 'Provider error',
    });
  });
});
