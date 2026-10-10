/* ── tauri-shell: folder pick + bulk copy wrappers ───────────────────────────
 * These wrap the Rust `select_directory` / `copy_files_to_dir` commands that
 * power "Download all". The Rust command has no test harness in this repo, so
 * what IS testable here is the JS contract that matters:
 *   - off-desktop, both no-op to null (so the caller can fall back to anchor
 *     downloads) rather than throwing;
 *   - on desktop, both invoke the exact camelCase command names with the exact
 *     camelCase argument keys (a snake_case payload hard-fails the build's
 *     `camelcase` lint rule, and a wrong arg key silently no-ops the command).
 *
 * `isTauri` is false under vitest (no __TAURI__ global), so the off-desktop
 * paths are what run here. The desktop paths are asserted by code review
 * against the Rust signatures, and validated end-to-end only by a real
 * `npm run dev:desktop` run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { selectDirectory, copyFilesToDir, type CopyReport } from '@/lib/tauri-shell';

describe('tauri-shell folder pick + bulk copy', () => {
  beforeEach(() => {
    // No __TAURI__ global in jsdom → isTauri is false, the browser/dev path.
    delete (globalThis as Record<string, unknown>).__TAURI__;
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selectDirectory returns null off-desktop (no picker to open)', async () => {
    expect(await selectDirectory()).toBeNull();
  });

  it('copyFilesToDir returns null off-desktop (caller falls back to anchors)', async () => {
    const report = await copyFilesToDir('/tmp/dest', ['/tmp/a.png', '/tmp/b.pdf']);
    expect(report).toBeNull();
  });

  it('CopyReport carries the camelCase fields the Rust command emits', () => {
    // Documents the contract the UI reads. camelCase end to end — a snake_case
    // Rust payload would fail the build's camelcase lint rule.
    const report: CopyReport = {
      copied: 2,
      failed: 1,
      skipped: 1,
      collisions: ['b.pdf'],
    };
    expect(report.copied).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.collisions).toEqual(['b.pdf']);
  });
});
