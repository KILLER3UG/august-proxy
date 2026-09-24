import { describe, expect, it, vi } from 'vitest';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn() },
}));

import { mapRemoteMessages } from '../session-history';

describe('mapRemoteMessages — structured transcript restore (migration 047)', () => {
  it('keeps a tool result as a tool bubble instead of a flattened JSON string', () => {
    const [msg] = mapRemoteMessages([
      {
        id: 7,
        role: 'tool',
        content: { content: 'print(1)', tool_use_id: 'toolu_1', name: 'read_file' },
        tool: { name: 'read_file', result: 'print(1)', status: 'done' },
        blocks: [
          {
            id: 'toolu_1',
            type: 'toolCall',
            content: 'print(1)',
            tool: { id: 'toolu_1', name: 'read_file', status: 'done', result: 'print(1)' },
          },
        ],
        createdAt: '2026-09-24 10:00:00',
      },
    ]);

    expect(msg.role).toBe('tool');
    expect(msg.content).toBe('print(1)');
    expect(msg.blocks?.[0].type).toBe('toolCall');
    expect(msg.tool?.name).toBe('read_file');
    expect(msg.remote).toBe(true);
  });

  it('restores reasoning, tool calls, attachments and todos from one row', () => {
    const [msg] = mapRemoteMessages([
      {
        id: 9,
        role: 'assistant',
        content: 'Done.',
        thinking: 'weighing two approaches',
        tools: [{ id: 't1', name: 'read_file', status: 'done', summary: 'read 12 lines' }],
        attachments: [{ name: 'notes.md', type: 'text' }],
        todos: [{ id: 'todo-1', content: 'ship it', status: 'pending' }],
        usage: { inputTokens: 12, outputTokens: 5 },
        turnEnd: { reason: 'finished', rounds: 2 },
        blocks: [
          { id: 'b_think_0', type: 'thinking', content: 'weighing two approaches' },
          { id: 'b_text_0', type: 'finalOutput', content: 'Done.' },
          { id: 'toolu_1', type: 'toolCall', tool: { id: 'toolu_1', name: 'read_file', status: 'done' } },
        ],
        createdAt: '2026-09-24 10:00:00',
      },
    ]);

    expect(msg.blocks).toHaveLength(3);
    expect(msg.thinking).toBe('weighing two approaches');
    expect(msg.tools?.[0].summary).toBe('read 12 lines');
    expect(msg.attachments?.[0].name).toBe('notes.md');
    expect(msg.todos?.[0].content).toBe('ship it');
    expect(msg.usage?.inputTokens).toBe(12);
    expect(msg.turnEnd?.reason).toBe('finished');
  });

  it('normalizes legacy thinking+system blocks to system blocks', () => {
    const [msg] = mapRemoteMessages([
      {
        id: 11,
        role: 'assistant',
        content: 'answer',
        blocks: [
          { id: 'b1', type: 'thinking', system: true, content: 'context pressure' },
          { id: 'b2', type: 'finalOutput', content: 'answer' },
        ],
      },
    ]);

    expect(msg.blocks?.[0].type).toBe('system');
    expect(msg.blocks?.[0].system).toBeUndefined();
  });

  it('falls back to plain text for a legacy row with no structured payload', () => {
    const [msg] = mapRemoteMessages([
      { id: 1, role: 'user', content: 'hello there', createdAt: '2026-09-24 10:00:00' },
    ]);

    expect(msg).toMatchObject({
      id: '1',
      role: 'user',
      content: 'hello there',
      remote: true,
    });
    expect(msg.blocks).toBeUndefined();
  });

  it('maps a legacy tool row without a tool payload to an assistant bubble', () => {
    const [msg] = mapRemoteMessages([
      { id: 2, role: 'tool', content: { content: 'legacy result' } },
    ]);

    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('legacy result');
  });

  it('does not drop a structured message that has no text at all', () => {
    const messages = mapRemoteMessages([
      {
        id: 3,
        role: 'assistant',
        content: '',
        blocks: [
          { id: 'toolu_2', type: 'toolCall', tool: { id: 'toolu_2', name: 'run_command', status: 'running' } },
        ],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].blocks?.[0].type).toBe('toolCall');
  });

  it('still skips empty legacy rows', () => {
    expect(mapRemoteMessages([{ id: 4, role: 'user', content: '   ' }])).toHaveLength(0);
  });
});
