import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

function renderContent(
  { isLast, streaming }: { isLast: boolean; streaming: boolean },
  messageOverrides: Partial<ChatMessage> = {},
) {
  const message = { ...makeMessage(), ...messageOverrides };
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

// turn_end stop-reason badge: the transcript answers "it froze after N
// commands" without opening the event log. A clean `finished` stop must stay
// quiet, and the raw token belongs in the tooltip, not the label.

const BADGE = 'turn-end-badge';
const badge = () => screen.queryByTestId(BADGE);

describe('AssistantMessageContent — turn_end stop-reason badge', () => {
  it('stays silent on a clean `finished` stop', () => {
    renderContent({ isLast: true, streaming: false }, { turnEnd: { reason: 'finished', rounds: 3 } });
    expect(badge()).toBeNull();
  });

  /* The badge grew a `<details>`: the raw token used to live in a `title`
 * attribute, which is unreachable by keyboard and by touch, and a stop reason
 * the user cannot act on is decoration. The label, the round count, the
 * wording and the warning/error coloring are unchanged — those are the
 * contracts worth keeping — but the detail is now visible text and every
 * non-`finished` reason except `interrupted` also names its remedy. */
const badgeLabel = (el: HTMLElement | null) =>
  el?.querySelector('summary')?.textContent ?? '';

  it('names a stalled stop in plain words, with the raw token visible on expand', () => {
    renderContent(
      { isLast: true, streaming: false },
      { turnEnd: { reason: 'stall-stop', rounds: 12, error: false } },
    );
    const el = badge();
    expect(badgeLabel(el)).toContain('stalled then stopped · 12 rounds');
    expect(el?.className).toContain('text-warning');
    // Raw token kept for the event log / turn_outcomes column.
    expect(el?.textContent).toContain('turn_end: stall-stop');
    // And it says what to do, not just what happened.
    expect(screen.queryByTestId('turn-end-remedy')?.textContent).toMatch(/continue|narrow/i);
  });

  it('reads as a failure, not a stall, when the turn errored', () => {
    renderContent({ isLast: true, streaming: false }, { turnEnd: { reason: 'error', rounds: 2, error: true } });
    const el = badge();
    expect(el?.className).toContain('text-danger-fg');
    expect(el?.className).not.toContain('text-warning');
  });

  it('singularizes one round', () => {
    renderContent({ isLast: true, streaming: false }, { turnEnd: { reason: 'cap', rounds: 1 } });
    expect(badgeLabel(badge())).toContain('tool-round cap · 1 round');
    expect(badgeLabel(badge())).not.toContain('1 rounds');
  });

  it('omits the round count when the frame carried none', () => {
    renderContent({ isLast: true, streaming: false }, { turnEnd: { reason: 'interrupted' } });
    const el = badge();
    expect(badgeLabel(el)).toBe('you stopped it· why?');
    expect(el?.textContent).toContain('turn_end: interrupted');
  });

  it('never renders a blank label when the reason is missing', () => {
    renderContent({ isLast: true, streaming: false }, { turnEnd: { error: true } });
    const el = badge();
    expect(badgeLabel(el)).toContain('stopped');
    expect(el?.textContent).toContain('no reason recorded');
  });

  it('points the tool-round cap at the control that raises it', () => {
    renderContent({ isLast: true, streaming: false }, { turnEnd: { reason: 'cap', rounds: 40 } });
    expect(screen.queryByTestId('turn-end-remedy')?.textContent).toMatch(/Settings/);
  });

  it('withholds the badge while the last turn is still streaming', () => {
    renderContent({ isLast: true, streaming: true }, { turnEnd: { reason: 'stall-stop', rounds: 9 } });
    expect(badge()).toBeNull();
  });
});
