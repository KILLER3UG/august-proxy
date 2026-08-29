/* Phase L (Part 17): the `upstreamRetry` SSE event (client-loop retry,
 * pre-first-token) parses into onUpstreamRetry — notice-only, distinct from
 * `retrying`'s buffer-rollback semantics. */
import { describe, it, expect, vi } from 'vitest';
import { dispatchWorkbenchEvent } from '@/api/workbench/streamEvents';
import type { WorkbenchEventHandlers } from '@/types/workbench';

describe('upstreamRetry event dispatch', () => {
  it('parses attempt/maxRetries/delayMs/status', () => {
    const onUpstreamRetry = vi.fn();
    const handlers: WorkbenchEventHandlers = { onUpstreamRetry };

    dispatchWorkbenchEvent(
      'upstreamRetry',
      { attempt: 1, maxRetries: 3, delayMs: 2000, status: 429 },
      handlers,
    );

    expect(onUpstreamRetry).toHaveBeenCalledWith({
      attempt: 1,
      maxRetries: 3,
      delayMs: 2000,
      status: 429,
    });
  });

  it('coerces missing numbers to zero', () => {
    const onUpstreamRetry = vi.fn();
    dispatchWorkbenchEvent('upstreamRetry', {}, { onUpstreamRetry });
    expect(onUpstreamRetry).toHaveBeenCalledWith({
      attempt: 0,
      maxRetries: 0,
      delayMs: 0,
      status: 0,
    });
  });

  it('never touches the retrying (rollback) handler', () => {
    const onRetrying = vi.fn();
    const onUpstreamRetry = vi.fn();
    dispatchWorkbenchEvent(
      'upstreamRetry',
      { attempt: 2, maxRetries: 3, delayMs: 4000, status: 503 },
      { onRetrying, onUpstreamRetry },
    );
    expect(onRetrying).not.toHaveBeenCalled();
    expect(onUpstreamRetry).toHaveBeenCalled();
  });
});
