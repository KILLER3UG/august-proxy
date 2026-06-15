#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..', '..');
const baseUrl = (process.env.AUGUST_AUDIT_BASE_URL || 'http://127.0.0.1:8085').replace(/\/+$/, '');
const artifactDir = path.join(appRoot, 'artifacts');

function loadPlaywright() {
  const candidates = [
    path.join(repoRoot, 'apps', 'host-agent', 'node_modules', 'playwright'),
    'playwright',
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (_) {
      // Try the next known install location.
    }
  }
  throw new Error('Playwright is not installed. Expected it in apps/host-agent/node_modules/playwright.');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(artifactDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => typeof window.switchSection === 'function', { timeout: 15000 });
    const featureSections = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-section]'))
        .map((node) => node.getAttribute('data-section'))
        .filter(Boolean),
    );
    assert(featureSections.length >= 13, `mobile web feature surface is incomplete (${featureSections.length} sections)`);

    for (const section of featureSections) {
      await page.evaluate((sectionName) => window.switchSection(sectionName), section);
      await page.waitForSelector(`#section-${section}:not(.hidden)`, { timeout: 15000 });
      const sectionState = await page.evaluate((sectionName) => {
        const documentElement = document.documentElement;
        const sectionNode = document.querySelector(`#section-${sectionName}`);
        const bottomNavs = Array.from(document.querySelectorAll('.bottom-nav, .tab-bar, [data-mobile-bottom-nav]'))
          .filter((node) => {
            const style = window.getComputedStyle(node);
            return style.display !== 'none' && style.visibility !== 'hidden' && node.getBoundingClientRect().height > 0;
          }).length;
        return {
          visible: Boolean(sectionNode && sectionNode.getBoundingClientRect().height > 0),
          overflowX: Math.ceil(documentElement.scrollWidth) > Math.ceil(documentElement.clientWidth) + 1,
          bottomNavs,
          scrollWidth: documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        };
      }, section);
      assert(sectionState.visible, `mobile feature section "${section}" is not visible after navigation`);
      assert(!sectionState.overflowX, `mobile feature section "${section}" has horizontal overflow (${sectionState.scrollWidth}/${sectionState.viewportWidth})`);
      assert(sectionState.bottomNavs === 0, `bottom navigation is visible on mobile section "${section}"`);
    }

    await page.evaluate(() => window.switchSection('workbench'));
    await page.waitForSelector('#section-workbench:not(.hidden)', { timeout: 15000 });
    await page.waitForSelector('#workbenchInput', { timeout: 15000 });
    await page.evaluate(async () => {
      if (typeof window.ensureWorkbenchSession === 'function') {
        await window.ensureWorkbenchSession();
      }
      if (typeof window.loadWorkbenchAgentsUI === 'function') {
        await window.loadWorkbenchAgentsUI(true);
      }
    });
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.wb-agent-card').length > 0 &&
        !/Loading agents/i.test(document.querySelector('#wbAgentRegistry')?.textContent || ''),
      { timeout: 15000 },
    );

    const before = await page.evaluate(() => {
      const body = document.body;
      const documentElement = document.documentElement;
      const header = document.querySelector('.wb-header');
      const mobileNav = document.querySelector('.wb-mobile-nav-btn');
      const mobileActionsToggle = document.querySelector('#wbMobileActionsToggle');
      const welcomeIcon = document.querySelector('.wb-welcome-icon');
      const composer = document.querySelector('.wb-input-pill');
      const headerRect = header ? header.getBoundingClientRect() : null;
      return {
        workbenchShell: documentElement.classList.contains('workbench-active') && body.classList.contains('workbench-active'),
        overflowX: Math.ceil(documentElement.scrollWidth) > Math.ceil(documentElement.clientWidth) + 1,
        pageOverflowY: Math.ceil(documentElement.scrollHeight) > Math.ceil(documentElement.clientHeight) + 1,
        bottomNavs: Array.from(document.querySelectorAll('.bottom-nav, .tab-bar, [data-mobile-bottom-nav]'))
          .filter((node) => {
            const style = window.getComputedStyle(node);
            return style.display !== 'none' && style.visibility !== 'hidden' && node.getBoundingClientRect().height > 0;
          }).length,
        composerVisible: Boolean(composer && composer.getBoundingClientRect().height > 0),
        headerVisible: Boolean(headerRect && headerRect.height > 0 && headerRect.top >= 0 && headerRect.bottom <= window.innerHeight + 1),
        headerFits: Boolean(header && Math.ceil(header.scrollWidth) <= Math.ceil(header.clientWidth) + 1),
        mobileNavVisible: Boolean(mobileNav && window.getComputedStyle(mobileNav).display !== 'none' && mobileNav.getBoundingClientRect().width > 0),
        mobileActionsVisible: Boolean(mobileActionsToggle && window.getComputedStyle(mobileActionsToggle).display !== 'none' && mobileActionsToggle.getBoundingClientRect().width > 0),
        welcomeIconColor: welcomeIcon ? window.getComputedStyle(welcomeIcon).color : '',
        bodyWidth: body.getBoundingClientRect().width,
        viewportWidth: window.innerWidth,
      };
    });

    assert(before.workbenchShell, 'mobile Workbench did not enter viewport app-shell mode');
    assert(!before.overflowX, `mobile Workbench has horizontal overflow (${before.bodyWidth}/${before.viewportWidth})`);
    assert(!before.pageOverflowY, 'mobile Workbench page scroll is enabled; expected viewport-owned app shell');
    assert(before.bottomNavs === 0, 'bottom navigation is visible on mobile');
    assert(before.composerVisible, 'Workbench composer is not visible');
    assert(before.headerVisible && before.headerFits, 'Workbench native header is not correctly fitted in the mobile viewport');
    assert(before.mobileNavVisible && before.mobileActionsVisible, 'Workbench mobile header controls are not visible');
    assert(!/128,\s*90,\s*213|139,\s*92,\s*246|99,\s*102,\s*241/.test(before.welcomeIconColor), `Workbench icon is still purple (${before.welcomeIconColor})`);

    await page.click('#wbMobileActionsToggle');
    await page.waitForFunction(() => document.querySelector('#wbHeaderActions')?.classList.contains('open'), { timeout: 5000 });
    const actionMenu = await page.evaluate(() => {
      const documentElement = document.documentElement;
      const menu = document.querySelector('#wbHeaderActions');
      const rect = menu ? menu.getBoundingClientRect() : null;
      return {
        open: Boolean(menu?.classList.contains('open')),
        visible: Boolean(rect && rect.width > 0 && rect.right <= window.innerWidth + 1 && rect.left >= -1),
        overflowX: Math.ceil(documentElement.scrollWidth) > Math.ceil(documentElement.clientWidth) + 1,
        pageOverflowY: Math.ceil(documentElement.scrollHeight) > Math.ceil(documentElement.clientHeight) + 1,
      };
    });
    assert(actionMenu.open && actionMenu.visible, 'Workbench mobile action menu did not open within the viewport');
    assert(!actionMenu.overflowX, 'Workbench mobile action menu creates horizontal overflow');
    assert(!actionMenu.pageOverflowY, 'Workbench mobile action menu creates page scroll');

    await page.click('button[title="Find an importable skill"]');
    const promptValue = await page.locator('#workbenchInput').inputValue();
    assert(/GitHub skill|browser automation/i.test(promptValue), 'Workbench prompt chip did not fill the composer');

    const sendDisabled = await page.locator('#workbenchSendBtn').evaluate((button) => button.disabled);
    assert(sendDisabled === false, 'Workbench send button did not enable after prompt fill');

    await page.click('#wbMobileActionsToggle');
    await page.waitForFunction(() => document.querySelector('#wbHeaderActions')?.classList.contains('open'), { timeout: 5000 });
    await page.click('#wbInfoToggle');
    await page.waitForFunction(() => document.querySelector('#wbDrawer')?.classList.contains('open'), { timeout: 5000 });
    await page.waitForFunction(
      () => {
        const drawerNode = document.querySelector('#wbDrawer');
        if (!drawerNode?.classList.contains('open')) return false;
        const rect = drawerNode.getBoundingClientRect();
        return rect.width > 0 && rect.left >= -1 && rect.right <= window.innerWidth + 1;
      },
      { timeout: 5000 },
    );
    await page.waitForSelector('.wb-agent-card.is-active', { timeout: 5000 });

    const drawer = await page.evaluate(() => {
      const documentElement = document.documentElement;
      const drawerNode = document.querySelector('#wbDrawer');
      const activeAgent = document.querySelector('.wb-agent-card.is-active');
      const rect = drawerNode ? drawerNode.getBoundingClientRect() : null;
      return {
        open: Boolean(drawerNode?.classList.contains('open')),
        visible: Boolean(rect && rect.width > 0 && rect.left >= -1 && rect.right <= window.innerWidth + 1),
        overflowX: Math.ceil(documentElement.scrollWidth) > Math.ceil(documentElement.clientWidth) + 1,
        pageOverflowY: Math.ceil(documentElement.scrollHeight) > Math.ceil(documentElement.clientHeight) + 1,
        drawerLeft: rect ? rect.left : null,
        drawerRight: rect ? rect.right : null,
        viewportWidth: window.innerWidth,
        activeAgentBackground: activeAgent ? window.getComputedStyle(activeAgent).backgroundColor : '',
        activeAgentBorder: activeAgent ? window.getComputedStyle(activeAgent).borderColor : '',
      };
    });

    assert(drawer.open && drawer.visible, 'Workbench info drawer did not open');
    assert(!drawer.overflowX, `mobile Workbench drawer has horizontal overflow (${drawer.drawerLeft}/${drawer.drawerRight}/${drawer.viewportWidth})`);
    assert(!drawer.pageOverflowY, 'mobile Workbench drawer creates page scroll');
    assert(!/124,\s*58,\s*237|139,\s*92,\s*246|99,\s*102,\s*241/.test(drawer.activeAgentBackground), `active agent card background is still purple (${drawer.activeAgentBackground})`);
    assert(!/124,\s*58,\s*237|139,\s*92,\s*246|99,\s*102,\s*241/.test(drawer.activeAgentBorder), `active agent card border is still purple (${drawer.activeAgentBorder})`);

    const screenshotPath = path.join(artifactDir, 'mobile-workbench-smoke.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`Mobile visual audit passed. Screenshot: ${screenshotPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`Mobile visual audit failed: ${error.message}`);
  process.exit(1);
});
