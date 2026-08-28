import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AssistantMessageContent } from '../AssistantMessageContent';
import type { ChatMessage, MessageBlock } from '@/types/chat';
import type { GitDiffResult } from '@/api/git';

// Bug 6: the unified ChangesCard must not render while the owning turn is
// still streaming (mid-stream totals are unsettled); it appears once the
// turn finishes. Non-last messages are never gated.

const changedFiles: GitDiffResult = {
  workspace: '/ws',
  added: 2,
  removed: 1,
  files: [
    { path: 'src/a.ts', status: 'modified', added: 2, removed: 1, diff: '@@ -1 +1 @@\n-x\n+y\n' },
  ],
};

function makeMessage(): ChatMessage {
  return {
    id: 'msg_gate',
    role: 'assistant',
    content: 'Done.',
    timestamp: new Date().toISOString(),
    blocks: [],
    changedFiles,
  };
}

const finalBlock: MessageBlock = { id: 'b_final', type: 'finalOutput', content: 'Done.' };

function renderContent({ isLast, streaming }: { isLast: boolean; streaming: boolean }) {
  const message = makeMessage();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AssistantMessageContent
          message={message}
          isLast={isLast}
          streaming={streaming}
          sessionId="sess_gate"
          displayBlocks={[finalBlock]}
          showPendingThinking={false}
          showRaw={false}
          setShowRaw={() => {}}
          showActions={false}
          copied={false}
          speaking={false}
          isRegenerating={false}
          onSpeak={() => {}}
          onCopy={() => {}}
          onRegen={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AssistantMessageContent — ChangesCard streaming gate (Bug 6)', () => {
  it('hides the ChangesCard while the last message is still streaming', () => {
    renderContent({ isLast: true, streaming: true });
    expect(screen.queryByTestId('changes-card-header')).toBeNull();
  });

  it('shows the ChangesCard once the turn has finished', () => {
    renderContent({ isLast: true, streaming: false });
    expect(screen.getByTestId('changes-card-header')).toBeTruthy();
  });

  it('does not gate older messages when a newer turn is streaming', () => {
    renderContent({ isLast: false, streaming: true });
    expect(screen.getByTestId('changes-card-header')).toBeTruthy();
  });
});
