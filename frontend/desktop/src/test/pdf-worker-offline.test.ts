/* ── pdf.js worker must be same-origin, not a CDN ──────────────────────────
 * The fix is a Vite `?url` import, which emits the worker as a same-origin
 * hashed asset. This test guards BOTH halves of that contract:
 *
 *   1. No CDN origin survives in the source (a regression to unpkg).
 *   2. The import is a real `?url` asset import, so Vite bundles it.
 *
 * A bare "no unpkg string" assertion is not enough on its own — the string
 * could be gone while the worker still points somewhere unreachable. The
 * `?url` import is the mechanism that actually makes it work, so it is what
 * gets pinned. `vite.config.ts` sets `publicDir: false`, which is precisely
 * why a public/ drop is not an option and `?url` is the only correct route.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(
  resolve(__dirname, '../lib/file-reader.ts'),
  'utf8',
);

const VITE_CONFIG = readFileSync(
  resolve(__dirname, '../../vite.config.ts'),
  'utf8',
);

/* Only executable code is scanned. Prose that *names* a CDN host while
 * explaining why we avoid it is the documentation of this fix, not a
 * regression, so comments are stripped before every assertion below. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the pdf.js worker is served from the app origin, not a CDN', () => {
  it('never points at a remote CDN', () => {
    // The regression: a workerSrc assembled from a template literal over a
    // hosted package registry. Any http(s) worker origin breaks offline use.
    expect(CODE).not.toMatch(/unpkg\.com/);
    expect(CODE).not.toMatch(/jsdelivr/);
    expect(CODE).not.toMatch(/cdn\./);
    expect(CODE).not.toMatch(/workerSrc\s*=\s*`https?:/);
  });

  it('imports the worker through a Vite ?url asset import', () => {
    // `?url` is what makes Vite emit the worker as a same-origin hashed file.
    // Without it the import either fails to resolve or pulls the worker into
    // the JS chunk as executable code rather than an asset.
    expect(SOURCE).toMatch(
      /import\s+\w+\s+from\s+['"]pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url['"]/,
    );
  });

  it('assigns that bundled URL to the pdf.js worker source', () => {
    // The import existing is not enough — it has to reach GlobalWorkerOptions.
    const assignment = SOURCE.match(
      /GlobalWorkerOptions\.workerSrc\s*=\s*(\w+)/,
    );
    expect(assignment).not.toBeNull();
    expect(assignment?.[1]).toBe('workerUrl');
  });

  it('documents why publicDir rules out the simpler alternative', () => {
    // If someone later "simplifies" this into a public/ drop, they need to
    // know that is disabled in this project. The comment is load-bearing.
    expect(SOURCE).toMatch(/publicDir/);
  });

  it('keeps publicDir disabled, which is why ?url is required', () => {
    // Guard the other half of the reasoning: if publicDir ever becomes true,
    // the ?url import is still correct, but the comment's premise changes.
    expect(VITE_CONFIG).toMatch(/publicDir:\s*false/);
  });
});
