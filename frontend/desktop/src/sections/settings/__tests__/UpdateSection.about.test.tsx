import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// The update button used to be invisible (hidden section + only-on-available).
// The About page must ALWAYS offer Check now, and surface Update now when a
// newer release is found — the user's core complaint.

const updateState = {
  isTauri: true,
  available: null as null | { version: string; body?: string; date?: string },
  checking: false,
  error: null as Error | null,
  installing: false,
  progress: { phase: 'idle', percent: null, downloadedBytes: 0, totalBytes: null },
  formatBytes: (n: number) => `${n} B`,
  install: vi.fn(),
  refresh: vi.fn(),
  cancelDownload: vi.fn(),
};

vi.mock('@/hooks/useAppUpdate', () => ({ useAppUpdate: () => updateState }));
vi.mock('@/hooks/useBackendStatus', () => ({
  useBackendStatus: () => ({
    status: { proxy: 'up', sync: 'ok' },
    sync: vi.fn(),
    isTauri: true,
  }),
}));
vi.mock('@/lib/tauri-detect', () => ({ isTauri: true }));
vi.mock('@/lib/tauri-shell', () => ({ openExternal: vi.fn() }));

import { UpdateSection } from '../UpdateSection';

describe('About / UpdateSection', () => {
  beforeEach(() => {
    updateState.available = null;
    updateState.error = null;
    updateState.checking = false;
    updateState.installing = false;
  });

  it('always shows Check now and the current-version header', () => {
    render(<UpdateSection />);
    expect(screen.getByTestId('about-check-now')).toBeTruthy();
    expect(screen.getByTestId('about-release-notes')).toBeTruthy();
    expect(screen.getByText('August')).toBeTruthy();
    expect(screen.getByText(/You're on the latest version/)).toBeTruthy();
  });

  it('shows Update now when a newer release is available', () => {
    updateState.available = { version: '0.19.0' };
    render(<UpdateSection />);
    expect(screen.getByTestId('about-update-now')).toBeTruthy();
    expect(screen.getByText(/A new update is ready: v0.19.0/)).toBeTruthy();
  });

  it('surfaces a failed check distinctly from up-to-date', () => {
    updateState.error = new Error('network down');
    render(<UpdateSection />);
    expect(screen.getByText(/Update check failed: network down/)).toBeTruthy();
    expect(screen.queryByText(/You're on the latest version/)).toBeNull();
  });
});
