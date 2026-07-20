import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SessionListNav } from '../SessionListNav';

describe('SessionListNav', () => {
  it('routes Automations, Skills, and Artifacts to chat-shell pages', () => {
    const onNavigate = vi.fn();
    render(
      <SessionListNav
        onNew={vi.fn()}
        onNavigate={onNavigate}
        onToggleCollapsed={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('sidebar-nav-automations'));
    expect(onNavigate).toHaveBeenCalledWith('/automations');

    fireEvent.click(screen.getByTestId('sidebar-nav-skills'));
    expect(onNavigate).toHaveBeenCalledWith('/skills');

    fireEvent.click(screen.getByTestId('sidebar-nav-artifacts'));
    expect(onNavigate).toHaveBeenCalledWith('/artifacts');
  });
});
