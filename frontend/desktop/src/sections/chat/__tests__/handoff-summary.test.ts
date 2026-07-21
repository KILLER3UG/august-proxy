import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildHandoffSummary,
  markHandoffPending,
  takeHandoffSummary,
  clearHandoffPending,
} from '../handoff-summary';
import type { ChatMessage } from '@/types/chat';

describe('handoff-summary', () => {
  beforeEach(() => {
    clearHandoffPending('s1');
  });

  it('builds a brief from user + assistant tool/thinking blocks', () => {
    const messages: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'Find bugs in this project',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
        blocks: [
          { id: 't1', type: 'thinking', content: 'I will explore the repo structure first.' },
          {
            id: 't2',
            type: 'toolCall',
            tool: {
              id: 'c1',
              name: 'list_directory',
              status: 'done',
              summary: 'backend-py',
            },
          },
        ],
      },
    ];
    const summary = buildHandoffSummary(messages, 'Nemotron');
    expect(summary).toContain('Interrupted model: Nemotron');
    expect(summary).toContain('Find bugs');
    expect(summary).toContain('Thinking:');
    expect(summary).toContain('list_directory');
    expect(summary).toMatch(/Continue from this state/i);
  });

  it('stores and consumes a pending handoff once', () => {
    markHandoffPending('s1', 'User asked X\nAssistant started Y', 'model-a');
    const first = takeHandoffSummary('s1');
    expect(first).toContain('model-a');
    expect(first).toContain('User asked X');
    expect(takeHandoffSummary('s1')).toBeNull();
  });
});
