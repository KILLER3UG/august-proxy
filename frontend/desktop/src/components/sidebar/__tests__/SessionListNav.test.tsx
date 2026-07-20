import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionListNav } from '../SessionListNav';

describe('SessionListNav', () => {
  it('routes Automations, Skills, and Artifacts to the correct settings sections', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <SessionListNav
        onNew={vi.fn()}
        onNavigate={onNavigate}
        onToggleCollapsed={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId('sidebar-nav-automations'));
    expect(onNavigate).toHaveBeenCalledWith('/automations');

    await user.click(screen.getByTestId('sidebar-nav-skills'));
    expect(onNavigate).toHaveBeenCalledWith('/skills');

    await user.click(screen.getByTestId('sidebar-nav-artifacts'));
    expect(onNavigate).toHaveBeenCalledWith('/artifacts');
  });
});
