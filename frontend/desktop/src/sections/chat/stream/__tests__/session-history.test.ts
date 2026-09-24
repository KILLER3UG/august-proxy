import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

import { api } from '@/api/client';
import { ensureSessionHistory, mapRemoteMessages } from '../session-history';
import { evictSessionStreamState, updateSessionStreamState, useSessionStreamStore } from '../session-stream-store';

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

describe('mapRemoteMessages — client identity (migration 048)', () => {
  it('restores a client-authored row under the client message id', () => {
    // The id the desktop minted is the identity the enrichment PATCH uses, so
    // the restored bubble must carry it — not the SQLite rowid.
    const [msg] = mapRemoteMessages([
      {
        id: 41,
        clientMessageId: 'm1712345678901',
        role: 'user',
        content: 'read a.py',
        createdAt: '2026-09-24 10:00:00',
      },
    ]);
    expect(msg.id).toBe('m1712345678901');
    expect(msg.remote).toBe(true);
  });

  it('falls back to the rowid for a server-derived row with no client id', () => {
    const [msg] = mapRemoteMessages([
      { id: 42, role: 'assistant', content: 'done', clientMessageId: null },
    ]);
    expect(msg.id).toBe('42');
  });
});

describe('ensureSessionHistory — reconciliation with client identity (048)', () => {
  const SESSION = 'sess-reconcile-048';

  afterEach(() => {
    evictSessionStreamState(SESSION);
    vi.clearAllMocks();
  });

  it('merges a synced local bubble with its restored row instead of duplicating it', async () => {
    // The desktop sent this turn and the server already stored it under the
    // client's id. A restore must produce ONE bubble that stays local, so the
    // next sync keeps PATCHing the same row.
    updateSessionStreamState(
      SESSION,
      () => ({
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'read a.py',
            timestamp: '2026-09-24T10:00:00.000Z',
            attachments: [{ id: 'f1', name: 'notes.md', type: 'text', status: 'ready' }],
          },
        ] as never,
        // 'missing' (not 'ready') is what makes ensureSessionHistory fetch.
        history: { status: 'missing' },
      }),
      { transcriptUpdate: 'stream' },
    );
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
        { id: 7, clientMessageId: 'm1', role: 'user', content: 'read a.py' },
        { id: 8, role: 'assistant', content: 'done' },
      ],
    });

    await ensureSessionHistory(SESSION);

    const messages = useSessionStreamStore.getState().bySession[SESSION].messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe('m1');
    // The local copy wins, so the bubble is not downgraded to a remote row.
    expect(messages[0].remote).toBeUndefined();
    expect(messages[0].attachments?.[0].name).toBe('notes.md');
    expect(messages[1].id).toBe('8');
  });
});

describe('ensureSessionHistory — subagent transcript recovery', () => {
  const SESSION = 'sess-recover-subagent';

  afterEach(() => {
    evictSessionStreamState(SESSION);
    vi.clearAllMocks();
  });

  const workerBlock = (jobId: string, content: string) => ({
    id: `b_sub_${jobId}`,
    type: 'subagent',
    subagent: {
      jobId,
      parentToolId: `toolu_${jobId}`,
      agentId: 'research',
      task: `task ${jobId}`,
      status: 'completed',
      startedAt: 1_000,
      finishedAt: 2_000,
      blocks: [{ id: `b_out_${jobId}`, type: 'finalOutput', content }],
    },
  });

  const liveContainer = (jobId: string, content: string) => ({
    id: `sb_${jobId}`,
    jobId,
    parentToolId: `toolu_${jobId}`,
    agentId: 'research',
    status: 'running' as const,
    startedAt: 1_000,
    blocks: [{ id: `b_out_${jobId}`, type: 'finalOutput' as const, content }],
  });

  it('rehydrates the worker timeline from the restored transcript', async () => {
    updateSessionStreamState(
      SESSION,
      () => ({ messages: [], history: { status: 'missing' } }),
      { transcriptUpdate: 'stream' },
    );
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
        {
          id: 9,
          role: 'assistant',
          content: 'all done',
          blocks: [workerBlock('job-1', 'the worker found two gaps')],
        },
      ],
    });

    await ensureSessionHistory(SESSION);

    const worker = useSessionStreamStore.getState().bySession[SESSION].subagentBlocks.get('job-1');
    // Before this, a reload left the inline row a status stub with no output.
    expect(worker).toBeDefined();
    expect(worker!.status).toBe('completed');
    expect(worker!.blocks.at(-1)!.content).toBe('the worker found two gaps');
  });

  it('keeps a live container over its stale stored snapshot so output never rewinds', async () => {
    updateSessionStreamState(
      SESSION,
      () => ({
        messages: [],
        history: { status: 'missing' },
        // A reconnect already resumed streaming this job: the live timeline
        // is ahead of whatever was last persisted.
        subagentBlocks: new Map([['job-1', liveContainer('job-1', 'fresh streamed text')]]),
      }),
      { transcriptUpdate: 'stream' },
    );
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
        {
          id: 9,
          role: 'assistant',
          content: 'all done',
          blocks: [workerBlock('job-1', 'stale persisted text')],
        },
      ],
    });

    await ensureSessionHistory(SESSION);

    const worker = useSessionStreamStore.getState().bySession[SESSION].subagentBlocks.get('job-1');
    expect(worker!.status).toBe('running');
    expect(worker!.blocks.at(-1)!.content).toBe('fresh streamed text');
  });

  it('restores workers the live map never saw, without duplicating the live one', async () => {
    updateSessionStreamState(
      SESSION,
      () => ({
        messages: [],
        history: { status: 'missing' },
        subagentBlocks: new Map([['job-1', liveContainer('job-1', 'live')]]),
      }),
      { transcriptUpdate: 'stream' },
    );
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [
        {
          id: 9,
          role: 'assistant',
          content: 'all done',
          blocks: [workerBlock('job-1', 'a'), workerBlock('job-2', 'b')],
        },
      ],
    });

    await ensureSessionHistory(SESSION);

    const blocks = useSessionStreamStore.getState().bySession[SESSION].subagentBlocks;
    expect([...blocks.keys()]).toEqual(['job-1', 'job-2']);
  });
});
