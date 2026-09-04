/* ── useChatSend: "Chat failed → Retry" re-sends CLEAN text (3.3) ──────
 * The retry action used to call send(requestText) — requestText already
 * carries the @git context block and the Bot-Mode @mentions note, and send()
 * re-runs both annotators, so each retry stacked another git block + another
 * bot note (compounding). The fix retries the clean latestText and routes
 * through a send ref. This test drives the real error → retry path and counts
 * the git sentinel in the outgoing message. */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const startChatStream = vi.fn();

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
// The @git annotator returns a fixed sentinel so we can count blocks.
vi.mock('@/lib/git-context', () => ({
  buildGitContextBlock: vi.fn(async () => '<<GIT>>'),
}));
// Bot-mention middleware: roster empty, annotation is identity — so the ONLY
// thing that can appear twice is the git block.
vi.mock('../../composer-mentions', () => ({
  getBotRoster: vi.fn(async () => []),
  annotateBotMentions: (text: string) => text,
  fetchBotMentions: vi.fn(async () => []),
}));
vi.mock('../../message-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../message-storage')>();
  return { ...actual, persistMessages: vi.fn(), clearComposerDraft: vi.fn() };
});

const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args), message: vi.fn(), success: vi.fn() },
}));

import { useChatSend } from '../useChatSend';
import type { ModelItem } from '../../model-display';
import type { ChatMessage } from '@/types/chat';

const model: ModelItem = { id: 'm', name: 'M', provider: 'p', contextWindow: 8000 };

const userMsg = (content: string): ChatMessage => ({
  id: 'm1',
  role: 'user',
  content,
  timestamp: new Date().toISOString(),
});

function makeOpts(content: string) {
  return {
    sessionId: 'sess_1',
    loadedSessionId: 'sess_1',
    input: content,
    setInput: vi.fn(),
    attachments: [],
    clearAttachments: vi.fn(),
    messages: [userMsg(content)],
    setMessages: vi.fn(),
    streaming: false,
    workbenchSessionId: 'wb_1',
    activeWorkbenchSessionId: 'wb_1',
    queuedMessages: [],
    modelForRequest: model,
    workbenchMode: 'full' as const,
    effort: 'medium' as const,
    thinkingEnabled: false,
    ensureWorkbenchSession: vi.fn().mockResolvedValue(null),
    setShowToolsDropdown: vi.fn(),
    setShowCommandsDropdown: vi.fn(),
    loadMessagesForSession: () => [userMsg(content)],
  };
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>{children}</MemoryRouter>
);

const gitCount = (msg: unknown): number => {
  const payload = (msg as { message?: string }).message ?? '';
  return (payload.match(/<<GIT>>/g) || []).length;
};

beforeEach(() => {
  startChatStream.mockReset();
  toastError.mockReset();
});

describe('useChatSend — retry re-sends clean text (3.3)', () => {
  it('retry sends ONE git block, not a compounding second one', async () => {
    // First turn fails; the retry turn succeeds.
    startChatStream.mockResolvedValueOnce('error').mockResolvedValue('done');
    const { result } = renderHook(() => useChatSend(makeOpts('summarize @git please')), {
      wrapper,
    });

    await act(async () => {
      await result.current.generateAIResponse([userMsg('summarize @git please')]);
    });

    // First send annotated the clean text with exactly one git block.
    expect(startChatStream).toHaveBeenCalledTimes(1);
    expect(gitCount(startChatStream.mock.calls[0][1])).toBe(1);

    // The failure surfaced a Retry action.
    const errOpts = toastError.mock.calls[0][1] as {
      action?: { onClick?: () => void };
    };
    expect(errOpts?.action?.onClick).toBeTypeOf('function');

    // Click Retry.
    await act(async () => {
      await errOpts.action!.onClick!();
    });

    // A second send went out, and it carries ONE git block — proving the
    // retry re-annotated the CLEAN text rather than the already-annotated
    // requestText (which would have produced two).
    expect(startChatStream).toHaveBeenCalledTimes(2);
    expect(gitCount(startChatStream.mock.calls[1][1])).toBe(1);
  });
});
