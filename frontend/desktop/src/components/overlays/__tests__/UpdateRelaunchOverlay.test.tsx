import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// The update dialog must use the conversation chrome (August titlebar + bubble
// thread + composer action row), not the old generic modal.

let installState: { installing: boolean; progress: Record<string, unknown> } = {
  installing: false,
  progress: { phase: 'idle' },
};
let laterVersion: string | null = null;
const setLaterMock = vi.fn((v: string | null) => {
  laterVersion = v;
});
const updateState = {
  available: null as null | { version: string; date?: string },
  formatBytes: (n: number) => `${n} B`,
  install: vi.fn(),
  cancelDownload: vi.fn(),
};

vi.mock('@/store/app-update-install', () => ({
  useAppUpdateInstallStore: (sel: (s: typeof installState) => unknown) => sel(installState),
  getUpdateLaterVersion: () => laterVersion,
  setUpdateLaterVersion: (v: string | null) => setLaterMock(v),
  UPDATE_FAILURE_COPY: { network: 'network', signature: 'signature', unknown: 'unknown' },
}));
vi.mock('@/hooks/useAppUpdate', () => ({
  useAppUpdate: () => updateState,
  useAppUpdateVersion: () => updateState.available?.version ?? null,
}));

import { UpdateRelaunchOverlay } from '../UpdateRelaunchOverlay';

describe('UpdateRelaunchOverlay — conversation chrome', () => {
  beforeEach(() => {
    installState = { installing: false, progress: { phase: 'idle' } };
    updateState.available = null;
    laterVersion = null;
    setLaterMock.mockClear();
  });

  it('renders nothing when not installing', () => {
    const { container } = render(<UpdateRelaunchOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the August titlebar + download progress + Cancel while downloading', () => {
    updateState.available = { version: '0.19.0' };
    installState = {
      installing: true,
      progress: { phase: 'downloading', percent: 57, downloadedBytes: 100, totalBytes: 200 },
    };
    render(<UpdateRelaunchOverlay />);
    expect(screen.getByText('August')).toBeTruthy();
    expect(screen.getByTestId('update-assistant').textContent).toContain('v0.19.0');
    expect(screen.getByText('Download progress')).toBeTruthy();
    expect(screen.getByTestId('update-cancel')).toBeTruthy();
  });

  it('offers Restart to update when ready', () => {
    updateState.available = { version: '0.19.0' };
    installState = { installing: true, progress: { phase: 'ready', percent: 100 } };
    render(<UpdateRelaunchOverlay />);
    expect(screen.getByTestId('update-restart')).toBeTruthy();
    expect(screen.getByText('ready')).toBeTruthy();
  });

  it('stays hidden when the user already chose Later for this version', () => {
    updateState.available = { version: '0.19.0' };
    installState = { installing: true, progress: { phase: 'ready', percent: 100 } };
    laterVersion = '0.19.0';
    const { container } = render(<UpdateRelaunchOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it('clicking Later persists the version (durable dismissal)', () => {
    updateState.available = { version: '0.19.0' };
    installState = { installing: true, progress: { phase: 'ready', percent: 100 } };
    render(<UpdateRelaunchOverlay />);
    screen.getByTestId('update-later').click();
    expect(setLaterMock).toHaveBeenCalledWith('0.19.0');
  });

  it('a remount after Later does not resurrect the dialog', () => {
    updateState.available = { version: '0.19.0' };
    installState = { installing: true, progress: { phase: 'ready', percent: 100 } };
    // Was a byte-identical copy of the test above with `laterVersion`
    // pre-set, so it proved nothing about durability. The contract is the round
    // trip: click Later, unmount, mount again, stay hidden.
    const { unmount } = render(<UpdateRelaunchOverlay />);
    screen.getByTestId('update-later').click();
    unmount();
    const again = render(<UpdateRelaunchOverlay />);
    expect(again.container.firstChild).toBeNull();
  });
});
