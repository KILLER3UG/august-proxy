import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActionNeededCard, parseActionNeeded } from '@/components/chat/ActionNeededCard';

vi.mock('@/components/shell/RightDrawerState', () => ({
  addRightDrawerSection: vi.fn(),
  useRightDrawer: () => ({ open: false }),
}));
vi.mock('@/api/workbench', () => ({ queueWorkbenchMessage: vi.fn().mockResolvedValue({}) }));
vi.mock('@/sections/chat/stream/session-id-map', () => ({
  resolveWorkbenchSessionId: () => 'wb_1',
}));

describe('parseActionNeeded (Part 27 F6)', () => {
  it('extracts the payload from a browser result', () => {
    const json = JSON.stringify({
      status: 'ok',
      actionNeeded: { instruction: 'Sign in to acme.com so I can continue.', screenshot: { path: '/x/y.png' } },
    });
    const p = parseActionNeeded(json);
    expect(p?.instruction).toContain('acme.com');
  });

  it('returns null for non-escalation results', () => {
    expect(parseActionNeeded('{"status":"ok","title":"Hi"}')).toBeNull();
    expect(parseActionNeeded(undefined)).toBeNull();
    expect(parseActionNeeded('not json')).toBeNull();
  });
});

describe('ActionNeededCard (Part 27 F6)', () => {
  it('renders instruction + Take over / I\'m done and dismisses on done', () => {
    render(
      <ActionNeededCard
        payload={{ instruction: 'Sign in to acme.com so I can continue.', screenshot: { path: '/x/y.png' } }}
      />,
    );
    expect(screen.getByTestId('action-needed-card')).toBeTruthy();
    expect(screen.getByText(/Sign in to acme.com/)).toBeTruthy();
    expect(screen.getByTestId('action-needed-take-over')).toBeTruthy();
    fireEvent.click(screen.getByTestId('action-needed-im-done'));
    // dismissed after I'm done
    expect(screen.queryByTestId('action-needed-card')).toBeNull();
  });
});
