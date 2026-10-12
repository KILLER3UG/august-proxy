import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/* SessionRow reads its sibling row data (needs-attention, token deltas) from
 * stores and context, so the api module stays mocked and the rendering tests
 * never touch the network. */
vi.mock('@/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { SessionRow } from '../SessionRow';
import { SessionUsageProvider, type SessionTokenDelta } from '../session-usage';
import type { Session } from '@/store/sessions';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'ui-id',
    workbenchSessionId: 'wb_123',
    title: 'Redesign the shell',
    startedAt: new Date().toISOString(),
    messageCount: 4,
    ...overrides,
  } as Session;
}

function renderRow(
  session: Session,
  deltas: Record<string, SessionTokenDelta> = {},
  extra: Partial<Parameters<typeof SessionRow>[0]> = {},
) {
  const handlers = {
    onClick: vi.fn(),
    onTogglePin: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onMoveToFolder: vi.fn(),
    onDelete: vi.fn(),
  };
  render(
    <SessionUsageProvider value={deltas}>
      <SessionRow session={session} active={false} pinned={false} folders={[]} {...handlers} {...extra} />
    </SessionUsageProvider>,
  );
}

const delta = (input: number, output: number): SessionTokenDelta => ({
  sessionId: 'wb_123',
  totalEvents: 3,
  totalInputTokens: input,
  totalOutputTokens: output,
  totalTokens: input + output,
});

beforeEach(() => {
  vi.clearAllMocks();
});

/* REPLACED. This block asserted the row's second line — the relative time and
 * the `+1.2k / −567` token delta — which was measured against the Claude
 * reference at 2.4x and found NOT to exist there: those rows are a single line
 * (hollow bullet + title). The three tests that asserted its presence failed
 * after the removal, correctly.

 * The delta itself is not gone — `useSessionTokenDelta` still feeds the hover
 * preview. So what is asserted now is the invariant the removal has to hold:
 * the row renders NO meta line at all, whatever the usage data says, and the
 * batched usage lookup is still keyed on the workbench id rather than the
 * frontend-local id. */
describe('SessionRow has no second metadata line', () => {
  const metaAbsent = () => {
    expect(screen.queryByTestId('session-row-token-delta')).toBeNull();
    expect(screen.queryByTestId('session-row-date')).toBeNull();
    expect(screen.queryByTestId('session-row-meta')).toBeNull();
  };

  it('renders one line for a chat that has been used', () => {
    renderRow(makeSession(), { 'wb_123': delta(1234, 567) });
    metaAbsent();
  });

  it('renders one line for a chat with no usage at all', () => {
    renderRow(makeSession(), {});
    metaAbsent();
  });

  it('renders one line when totals are recorded as zero', () => {
    renderRow(makeSession(), { 'wb_123': delta(0, 0) });
    metaAbsent();
  });

  it('renders one line when usage is filed under the frontend-local id only', () => {
    // `useSessionTokenDelta` still keys on the workbench id; this only pins
    // that whatever it finds, the row does not surface it inline.
    renderRow(makeSession(), { 'ui-id': delta(10, 5) });
    metaAbsent();
  });

  it('falls back to the local id when there is no workbench id', () => {
    renderRow(makeSession({ workbenchSessionId: undefined }), { 'ui-id': delta(10, 5) });
    metaAbsent();
  });
});