/* global process, console, localStorage, document */
/* ── Visual regression capture (dev-only) ─────────────────────────── */
/* Run via: node scripts/capture-screenshots.mjs                       */
/* Requires the Vite dev server to be running on http://127.0.0.1:5191 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = process.env.SCREENSHOT_BASE ?? 'http://localhost:5173';
const OUT = process.env.SCREENSHOT_OUT ?? './screenshots';

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1.5,
  colorScheme: 'dark',
  bypassCSP: true,
});

await ctx.addInitScript(() => {
  localStorage.setItem('august-onboarding-skipped', 'true');
  localStorage.setItem('august-setup-checklist-done', 'true');
  localStorage.setItem('august_tour_seen', 'true');
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
  await snap('02-empty-chat-dark', '/', { fullPage: false, wait: 1200 });

  // Toggle to light mode by setting localStorage + reloading
  await page.evaluate(() => {
    localStorage.setItem('august.theme', 'light');
    localStorage.setItem('august.textSize', 'default');
    document.documentElement.classList.remove('dark');
  });
  await snap('03-empty-chat-light', '/', { fullPage: false, wait: 1200 });

  // Back to dark mode
  await page.evaluate(() => {
    localStorage.setItem('august.theme', 'dark');
    document.documentElement.classList.add('dark');
  });

  // Settings
  await snap('04-settings-general', '/settings/general', { wait: 1200 });
  await snap('05-settings-appearance', '/settings/appearance', { wait: 1200 });
  await snap('06-settings-models', '/settings/model-providers', { wait: 1200 });
  await snap('07-settings-mcp', '/settings/tools-connections', { wait: 1200 });
  await snap('08-settings-memory', '/settings/memory-knowledge', { wait: 1200 });
  await snap('09-settings-skills', '/settings/skills', { wait: 1200 });
  await snap('10-settings-usage', '/settings/usage', { wait: 1200 });
  await snap('11-settings-about-updates', '/settings/app-updates', { wait: 1200 });

  // Main surfaces
  await snap('12-automations', '/automations', { wait: 1200 });
  await snap('13-runs', '/runs', { wait: 1200 });
  await snap('14-board', '/board', { wait: 1200 });
  await snap('15-live', '/live', { wait: 1200 });
  await snap('16-history', '/history', { wait: 1200 });

  // Modals
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.keyboard.press('?');
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, '17-shortcuts-modal.png') });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, '18-command-palette.png') });

  console.log('\nAll screenshots saved to', OUT);
} catch (e) {
  console.error('Screenshot capture failed:', e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
