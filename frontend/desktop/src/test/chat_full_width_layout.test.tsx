import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ChatLayout full-width chat column', () => {
  const path = resolve(__dirname, '../components/shell/ChatLayout.tsx');
  const src = readFileSync(path, 'utf8');

  it('chat column does not cap with max-w-3xl on its outermost wrapper', () => {
    // The outermost chat column should not have max-w-3xl (it's removed so the
    // scroll container can span the full chat-area width). The wrapper is the
    // div carrying the `august-chat-column` hook class that --august-drawer-w
    // keys on, so the guard anchors there rather than on how the routes are
    // mounted inside it.
    const idx = src.indexOf('august-chat-column');
    expect(idx).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, idx - 800), idx);
    // The max-w-3xl cap should NOT appear in the wrapper just before the chat
    // column — any hit means the outermost wrapper is capped again.
    expect(before).not.toMatch(/max-w-3xl/);
    // The chat column must no longer use justify-center to center a max-width box.
    expect(before).not.toMatch(/justify-center/);
  });

  it('settings is an overlay over a background-location chat, not an Outlet swap', () => {
    // The chat surface keeps rendering while /settings/* is open: the chat
    // <Routes> carries the BACKGROUND location (where the user was), and the
    // settings dialog renders from a separate <Routes> against the real one.
    // A plain `<Outlet/>` swap here unmounts ChatThread — streams die, scroll
    // position is lost — which is the pre-dialog behavior this replaced.
    expect(src).toMatch(/<Routes location=\{isSettings \? background : undefined\}>/);
    expect(src).toMatch(/CHAT_SURFACE_ROUTES/);
    expect(src).toMatch(/SETTINGS_PAGE_ELEMENT/);
  });
});
