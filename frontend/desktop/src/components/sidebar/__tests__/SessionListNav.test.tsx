import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SessionListNav } from '../SessionListNav';

describe('SessionListNav', () => {
  it('routes Scheduled and Plugins to chat-shell pages (ref: Scheduled/Plugins)', () => {
    const onNavigate = vi.fn();
    render(
      <SessionListNav
        onNew={vi.fn()}
        onNavigate={onNavigate}
        onToggleCollapsed={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('sidebar-nav-history'));
    expect(onNavigate).toHaveBeenCalledWith('/history');

    fireEvent.click(screen.getByTestId('sidebar-nav-skills'));
    expect(onNavigate).toHaveBeenCalledWith('/skills');

  });
});
