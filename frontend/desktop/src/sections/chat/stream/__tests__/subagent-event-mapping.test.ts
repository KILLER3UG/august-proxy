/**
 * The `subagent*` → block-event vocabulary contract.
 *
 * The right-drawer transcript replay and the live SSE reducer read the SAME
 * jsonl frames, and they used to disagree: the replay filtered on
 * `text`/`thinking`/`toolCall`/`finalOutput` against a transcript that only ever
 * contains `subagentText`/`subagentToolCall`/`subagentDone`, so every settled
 * worker's tab rendered nothing after a reload. Both now call
 * `subagentEventToBlockEvent`, and this file is what pins that a frame the
 * backend actually writes has a mapping.
 */

import { describe, expect, it } from 'vitest';
import {
  subagentEventToBlockEvent,
  subagentResultText,
  type SubagentStreamEvent,
} from '../apply-subagent-event';

/** Every frame type the orchestrator appends to `cache/delegation/<task>.jsonl`
 *  — the list mirrors the emit sites in `subagent.py`, `subagent_worker.py` and
 *  `subagent_orchestrator.py`, not the UI's internal block names. */
const TRANSCRIPT_VOCABULARY = [
  'subagentStart',
  'subagentRunning',
  'subagentText',
  'subagentToolCall',
  'subagentToolResult',
  'subagentTodos',
  'subagentRetry',
  'subagentWarning',
  'subagentDone',
] as const;

describe('subagentEventToBlockEvent', () => {
  it('maps every content frame the backend writes', () => {
    const mapped = TRANSCRIPT_VOCABULARY.filter((type) => {
      const event = {
        type, jobId: 'task_1', id: 'tu_1', name: 'read_file', content: 'x', result: 'x',
      } as unknown as SubagentStreamEvent;
      return subagentEventToBlockEvent(event) !== null;
    });
    // Lifecycle frames carry no output; `subagentTodos` has no block form here
    // (worker plans arrive via the roster poll). Everything else must map.
    expect(mapped).toEqual(
      expect.arrayContaining([
        'subagentText',
        'subagentToolCall',
        'subagentToolResult',
        'subagentRetry',
        'subagentWarning',
        'subagentDone',
      ]),
    );
    for (const lifecycle of ['subagentStart', 'subagentRunning']) {
      expect(mapped).not.toContain(lifecycle);
    }
  });

  it('turns a text frame into a text block', () => {
    expect(
      subagentEventToBlockEvent({ type: 'subagentText', jobId: 't', content: 'working' }),
    ).toEqual({ type: 'text', content: 'working' });
  });

  it('surfaces a warning frame instead of dropping it', () => {
    const block = subagentEventToBlockEvent({
      type: 'subagentWarning',
      jobId: 't',
      message: 'worker was steered',
    });
    expect(block?.type).toBe('text');
    expect(block?.content).toContain('worker was steered');
  });

  it('renders the settled result as finalOutput', () => {
    expect(
      subagentEventToBlockEvent({ type: 'subagentDone', jobId: 't', status: 'completed', result: 'the answer' }),
    ).toEqual({ type: 'finalOutput', content: 'the answer' });
  });

  it('a done frame with no text contributes no block', () => {
    expect(
      subagentEventToBlockEvent({ type: 'subagentDone', jobId: 't', status: 'cancelled', result: '   ' }),
    ).toBeNull();
  });

  it('survives the dict payload that used to throw and kill the stream', () => {
    // A non-string `result` used to hit `.trim()` and the SSE reader swallowed
    // the exception — dropping subagentDone forever and leaving the row stuck
    // on "running".
    expect(subagentResultText({ result: 'nested text' })).toBe('nested text');
    expect(subagentResultText({ output: 'out' })).toBe('out');
    expect(subagentResultText({ other: 1 })).toContain('"other"');
    expect(subagentResultText(undefined)).toBe('');
    expect(subagentResultText(null)).toBe('');
  });
});
