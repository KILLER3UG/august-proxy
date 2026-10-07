import { describe, it, expect } from 'vitest';
import { parseSubagentReceipt, describeSubagentReceipt } from '../subagent-receipt';

// Verbatim shape produced by spawn_subagents_tool.py:365-371.
const FULL = [
  '[SUBAGENT_COMPLETE taskId="task_e7bae7f9024d" agentId="general" status="failed"]',
  'goal: Review uncommitted working-tree changes',
  'I could not complete this: permission denied on ./data',
  '[/SUBAGENT_COMPLETE]',
].join('\n');

describe('parseSubagentReceipt', () => {
  it('parses the full envelope the backend emits', () => {
    const r = parseSubagentReceipt(FULL);
    expect(r).not.toBeNull();
    expect(r!.taskId).toBe('task_e7bae7f9024d');
    expect(r!.agentId).toBe('general');
    expect(r!.status).toBe('failed');
    expect(r!.goal).toBe('Review uncommitted working-tree changes');
    expect(r!.body).toBe('I could not complete this: permission denied on ./data');
  });

  it('parses a truncated payload with no closing tag', () => {
    const r = parseSubagentReceipt(
      '[SUBAGENT_COMPLETE taskId="t1" agentId="scout" status="completed"]\ngoal: Map repo shape\nfound 12 modules',
    );
    expect(r!.status).toBe('completed');
    expect(r!.agentId).toBe('scout');
    expect(r!.goal).toBe('Map repo shape');
    expect(r!.body).toBe('found 12 modules');
  });

  it('tolerates an envelope with no goal line', () => {
    const r = parseSubagentReceipt('[SUBAGENT_COMPLETE taskId="t2" agentId="a" status="ok"]\nresult text\n[/SUBAGENT_COMPLETE]');
    expect(r!.goal).toBe('');
    expect(r!.body).toBe('result text');
  });

  it('leaves ordinary messages alone', () => {
    expect(parseSubagentReceipt('can you look at this file?')).toBeNull();
    expect(parseSubagentReceipt('[SYSTEM] something')).toBeNull();
    expect(parseSubagentReceipt('')).toBeNull();
    expect(parseSubagentReceipt(null)).toBeNull();
  });
});

describe('describeSubagentReceipt', () => {
  it('names the agent only when it is not the default', () => {
    expect(describeSubagentReceipt(parseSubagentReceipt(FULL)!)).toBe('Subagent failed');
    const named = parseSubagentReceipt('[SUBAGENT_COMPLETE taskId="t" agentId="scout" status="completed"]\ngoal: x\n[/SUBAGENT_COMPLETE]')!;
    expect(describeSubagentReceipt(named)).toBe('Subagent “scout” finished');
  });
});
