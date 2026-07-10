/* global process, console, localStorage */
/* ── Visual regression capture (dev-only) ─────────────────────────── */
/* Run via: node scripts/capture-screenshots.mjs                       */
/* Requires the Vite dev server to be running on http://127.0.0.1:5191 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = process.env.SCREENSHOT_BASE ?? 'http://127.0.0.1:5191/v2';
const OUT = process.env.SCREENSHOT_OUT ?? './screenshots';

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  bypassCSP: true,
});
// Disable HTTP cache so HMR-updated modules are always picked up
await ctx.route('**/*', (route) => {
  const headers = { ...route.request().headers(), 'cache-control': 'no-cache, no-store', pragma: 'no-cache' };
  route.continue({ headers });
});

const page = await ctx.newPage();
page.on('pageerror', (err) => console.error('[pageerror]', err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('[console.error]', msg.text());
});

async function snap(name, url, options = {}) {
  console.log(`→ ${name} (${url})`);
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // Wait for an explicit marker if provided
  if (options.waitFor) {
    try {
      await page.waitForSelector(options.waitFor, { timeout: 8_000 });
    } catch {
      console.warn(`  ! selector "${options.waitFor}" not found, continuing`);
    }
  }
  await page.waitForTimeout(options.wait ?? 800);
  const h1Text = await page.locator('h1').first().textContent().catch(() => null);
  console.log(`  url is now: ${page.url()}`);
  console.log(`  h1 text:    ${JSON.stringify(h1Text)}`);
  const out = join(OUT, `${name}.png`);
  await page.screenshot({ path: out, fullPage: options.fullPage ?? false });
  console.log(`  saved ${out}`);
}

try {
  await snap('01-design-system', '/_design', { fullPage: true, waitFor: 'h1.hero-display' });
  await snap('02-empty-chat-dark', '/c/demo', { fullPage: false, waitFor: 'h1' });
  // Toggle to light mode by setting localStorage + reloading
  await page.evaluate(() => {
    localStorage.setItem('august.theme', 'light');
    localStorage.setItem('august.textSize', 'default');
  });
  await snap('03-empty-chat-light', '/c/demo', { fullPage: false, waitFor: 'h1' });
  // Settings → appearance
  await page.evaluate(() => {
    localStorage.setItem('august.theme', 'dark');
    localStorage.setItem('august.textSize', 'spacious');
  });
  await snap('04-settings-appearance-spacious', '/settings/profile-preferences', { wait: 1500, waitFor: 'h1, h2' });
  // Compact text size
  await page.evaluate(() => {
    localStorage.setItem('august.textSize', 'compact');
  });
  await snap('05-settings-appearance-compact', '/settings/profile-preferences', { wait: 1200, waitFor: 'h1, h2' });
  console.log('\nAll screenshots saved to', OUT);
} catch (e) {
  console.error('Screenshot capture failed:', e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
