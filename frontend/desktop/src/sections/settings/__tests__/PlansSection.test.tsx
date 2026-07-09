/**
 * Tests for the PlansSection settings surface (AUG.md plan/todo cleanup).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockArtifacts = [
  {
    kind: 'plans',
    slug: 'my-plan-abc123',
    title: 'My Plan',
    status: 'pending',
    createdAt: '2026-07-08T00:00:00Z',
    updatedAt: '2026-07-08T00:00:00Z',
    sessionId: 'wb_abc123',
    path: '/w/.aug/plans/my-plan-abc123/plan.json',
  },
  {
    kind: 'todoList',
    slug: 'release-work-def456',
    title: 'Release work',
    status: 'active',
    createdAt: '2026-07-08T01:00:00Z',
    updatedAt: '2026-07-08T01:00:00Z',
    sessionId: 'wb_def456',
    path: '/w/.aug/todoList/release-work-def456/todos.json',
  },
];

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: apiMock }));

vi.mock('@/store/workspaces', () => ({
  getCurrentWorkspace: () => ({ id: 'w1', name: 'myproject', path: '/w', lastUsedAt: '' }),
}));

import { PlansSection } from '../PlansSection';

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.get.mockResolvedValue({ artifacts: mockArtifacts });
  apiMock.delete.mockResolvedValue({ removed: true });
});

describe('PlansSection', () => {
  it('lists artifacts returned by the API', async () => {
    render(<PlansSection />);
    expect(await screen.findByText('My Plan')).toBeInTheDocument();
    expect(screen.getByText('Release work')).toBeInTheDocument();
    // Two kind badges (Plan / Todo)
    expect(screen.getAllByText('Plan').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Todo').length).toBeGreaterThan(0);
  });

  it('shows empty state when no artifacts', async () => {
    apiMock.get.mockResolvedValue({ artifacts: [] });
    render(<PlansSection />);
    expect(await screen.findByText(/No .aug artifacts/i)).toBeInTheDocument();
  });

  it('deletes an artifact after confirmation', async () => {
    render(<PlansSection />);
    const deleteButtons = await screen.findAllByLabelText('Delete artifact');
    fireEvent.click(deleteButtons[0]);
    // Confirm step: a "Delete" button appears
    const confirmBtn = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(apiMock.delete).toHaveBeenCalledTimes(1);
    });
    expect(apiMock.delete).toHaveBeenCalledWith(
      '/api/aug/plans/plans/my-plan-abc123?workspacePath=' + encodeURIComponent('/w'),
    );
  });
});
