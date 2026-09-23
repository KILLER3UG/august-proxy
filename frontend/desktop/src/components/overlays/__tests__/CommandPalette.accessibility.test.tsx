import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  closePalette: vi.fn(),
  navigate: vi.fn(),
  invalidateQueries: vi.fn(),
  toggleTheme: vi.fn(),
  openShortcutsModal: vi.fn(),
  openConversationSearch: vi.fn(),
  dispatchUiAction: vi.fn(),
  post: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: '/' }),
}));
vi.mock('@/store/command-palette', () => ({
  useCommandPaletteStore: (select: (state: { open: boolean }) => unknown) =>
    select({ open: true }),
  closeCommandPalette: mocks.closePalette,
}));
vi.mock('@/store/sessions', () => ({
  useSessionsStore: (select: (state: { sessions: unknown[] }) => unknown) =>
    select({ sessions: [] }),
}));
vi.mock('@/store/theme', () => ({
  useResolvedThemeStore: (select: (state: { theme: string }) => unknown) =>
    select({ theme: 'light' }),
  toggleTheme: mocks.toggleTheme,
}));
vi.mock('@/routes', () => ({
  SECTION_NAV_ITEMS: [],
  SETTINGS_TABS: [],
}));
vi.mock('@/api/client', () => ({ api: { post: mocks.post } }));
vi.mock('@/api/ui-events', () => ({ dispatchUiAction: mocks.dispatchUiAction }));
vi.mock('@/store/conversation-search', () => ({
  openConversationSearch: mocks.openConversationSearch,
}));
vi.mock('@/store/shortcuts-modal', () => ({
  openShortcutsModal: mocks.openShortcutsModal,
}));
vi.mock('@/hooks/useFocusTrap', () => ({
  useFocusTrap: () => ({ current: null }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));
vi.mock('../Backdrop', () => ({
  Backdrop: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { CommandPalette } from '../CommandPalette';

describe('CommandPalette — semantic shortcuts', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    });
    if (typeof ResizeObserver === 'undefined') {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        writable: true,
        value: class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      });
    }
    if (!HTMLElement.prototype.scrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        writable: true,
        value: vi.fn(),
      });
    }
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders shortcut hints as keyboard elements instead of CSS-only text', () => {
    const { container } = render(<CommandPalette />);

    const shortcutTexts = Array.from(container.querySelectorAll('kbd'))
      .map((element) => element.textContent?.trim())
      .filter(Boolean);

    expect(shortcutTexts).toEqual(expect.arrayContaining(['⌘N', ',', '?']));
    expect(container.querySelectorAll('kbd').length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector('[data-shortcut]')).toBeNull();
  });
});
