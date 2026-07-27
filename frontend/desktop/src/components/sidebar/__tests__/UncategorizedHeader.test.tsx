import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UncategorizedHeader } from '../FolderTree';

describe('UncategorizedHeader (Other chats)', () => {
  it('offers a new-chat action even when the group is empty', () => {
    const onNewSession = vi.fn();
    render(
      <UncategorizedHeader
        count={0}
        isCollapsed={false}
        onToggleCollapse={vi.fn()}
        onNewSession={onNewSession}
        onDelete={vi.fn()}
      />,
    );

    const add = screen.getByRole('button', { name: 'New chat in Other chats' });
    fireEvent.click(add);
    expect(onNewSession).toHaveBeenCalledTimes(1);
    // Delete-all stays hidden while there is nothing to delete.
    expect(screen.queryByRole('button', { name: 'Delete all other chats' })).toBeNull();
  });

  it('creates without collapsing the group (click does not bubble)', () => {
    const onToggleCollapse = vi.fn();
    render(
      <UncategorizedHeader
        count={2}
        isCollapsed={false}
        onToggleCollapse={onToggleCollapse}
        onNewSession={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New chat in Other chats' }));
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });
});
