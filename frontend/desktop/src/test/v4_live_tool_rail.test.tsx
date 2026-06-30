import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveToolRail } from '@/sections/live/LiveToolRail';

describe('v4 — LiveToolRail', () => {
  it('renders one card per tool event', () => {
    const events = [
      { id: 't1', name: 'read_file', args: { path: 'auth.py' }, status: 'done' as const },
      { id: 't2', name: 'brain_query', args: { q: 'recent errors' }, status: 'running' as const },
    ];
    render(<LiveToolRail events={events} />);
    expect(screen.getByText('read_file')).toBeTruthy();
    expect(screen.getByText('brain_query')).toBeTruthy();
    // Args are rendered as JSON-stringified text
    expect(screen.getByText(/auth\.py/)).toBeTruthy();
  });

  it('renders empty state when no events', () => {
    render(<LiveToolRail events={[]} />);
    expect(screen.getByText(/no tool activity/i)).toBeTruthy();
  });

  it('marks running tools with a status indicator', () => {
    const events = [{ id: 't1', name: 'web_fetch', args: {}, status: 'running' as const }];
    const { container } = render(<LiveToolRail events={events} />);
    expect(container.querySelector('[data-status="running"]')).toBeTruthy();
  });
});
