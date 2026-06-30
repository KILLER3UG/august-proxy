import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ChatLayout full-width chat column', () => {
  it('chat column does not cap with max-w-3xl on its outermost wrapper', () => {
    const path = resolve(__dirname, '../components/shell/ChatLayout.tsx');
    const src = readFileSync(path, 'utf8');
    // The outermost chat column should not have max-w-3xl (it's removed so the
    // scroll container can span the full chat-area width). The chat Outlet is
    // the LAST <Outlet in the file (the first one is the Settings outlet).
    const idx = src.lastIndexOf('<Outlet');
    expect(idx).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, idx - 800), idx);
    // The max-w-3xl cap should NOT appear in the chat-column wrapper just before
    // the chat Outlet. The chat column is a sibling of the Settings Outlet, so
    // any `max-w-3xl` near the chat Outlet would indicate the outermost wrapper
    // is still capped.
    expect(before).not.toMatch(/max-w-3xl/);
    // The chat column must no longer use justify-center to center a max-width box.
    expect(before).not.toMatch(/justify-center/);
  });
});
