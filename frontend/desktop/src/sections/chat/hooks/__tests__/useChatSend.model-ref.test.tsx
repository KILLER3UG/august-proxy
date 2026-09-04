import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

// Bug 2: after a model switch, the turn must go out on the NEW model even
// when generateAIResponse is invoked through a captured (stale) closure.
// The fix reads the model from a ref that is refreshed every render.

const startChatStream = vi.fn().mockResolvedValue('done');

vi.mock('../../chat-runtime', () => ({
  chatRuntime: { canStartTurn: () => true, abortSession: vi.fn() },
}));
vi.mock('../../chat-stream-manager', () => ({
  startChatStream: (...args: unknown[]) => startChatStream(...args),
  activeStreamControllers: new Map(),
}));
vi.mock('@/api/workbench', () => ({
  queueWorkbenchMessage: vi.fn().mockResolvedValue({ id: 'q1', text: '' }),
  dequeueWorkbenchMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/store/gateway', () => ({
  $gateway: { get: () => ({ status: 'open' }) },
}));
vi.mock('@/lib/chat-chime', () => ({ playSendChime: vi.fn() }));
vi.mock('@/api/voice/registry', () => ({
  voiceCommandRegistry: { getBySlashCommand: () => null },
}));
vi.mock('@/store/sessions', () => ({
  updateSessionModel: vi.fn(),
  renameSession: vi.fn(),
  isPlaceholderTitle: () => false,
  deriveSnippetTitle: () => '',
  useSessionsStore: Object.assign(() => undefined, {
    getState: () => ({ sessions: [] }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  }),
}));

import { useChatSend } from '../useChatSend';
import type { ModelItem } from '../../model-display';
import type { ChatMessage } from '@/types/chat';

const modelA: ModelItem = { id: 'model-a', name: 'A', provider: 'prov-a', contextWindow: 8000 };
const modelB: ModelItem = { id: 'model-b', name: 'B', provider: 'prov-b', contextWindow: 8000 };

const userMsg: ChatMessage = {
  id: 'm1',
  role: 'user',
  content: 'hello world',
  timestamp: new Date().toISOString(),
};

function makeOpts(modelForRequest: ModelItem | null) {
  return {
    sessionId: 'sess_1',
    loadedSessionId: 'sess_1',
    input: 'hello world',
    setInput: vi.fn(),
    attachments: [],
    clearAttachments: vi.fn(),
    messages: [userMsg],
    setMessages: vi.fn(),
    streaming: false,
    workbenchSessionId: 'wb_1',
    activeWorkbenchSessionId: 'wb_1',
    queuedMessages: [],
    modelForRequest,
    workbenchMode: 'full' as const,
    effort: 'medium' as const,
    thinkingEnabled: false,
    ensureWorkbenchSession: vi.fn().mockResolvedValue(null),
    setShowToolsDropdown: vi.fn(),
    setShowCommandsDropdown: vi.fn(),
    loadMessagesForSession: () => [userMsg],
  };
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>{children}</MemoryRouter>
);

describe('useChatSend — fresh model via ref (Bug 2)', () => {
  beforeEach(() => {
    startChatStream.mockClear();
  });

  it('sends with the newest model even through a stale generateAIResponse closure', async () => {
    const { result, rerender } = renderHook(
      ({ model }: { model: ModelItem | null }) => useChatSend(makeOpts(model)),
      { wrapper, initialProps: { model: modelA } },
    );

    // Capture the callback produced while model A was selected.
    const staleGenerate = result.current.generateAIResponse;

    // User switches the model; the ref is refreshed on this render.
    rerender({ model: modelB });

    await act(async () => {
      await staleGenerate([userMsg]);
    });

    expect(startChatStream).toHaveBeenCalledTimes(1);
    const [sessionId, payload] = startChatStream.mock.calls[0];
    expect(sessionId).toBe('sess_1');
    expect(payload).toMatchObject({
      model: 'model-b',
      modelProvider: 'prov-b',
      provider: 'prov-b',
    });
  });
});
