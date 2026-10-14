/**
 * Real-browser check of the transcript's tool rows.
 *
 * The rule this pins is the plan's B2: show the file name, keep the full path
 * reachable, and never rewrite the value the model sees. jsdom can assert the
 * string a helper returns; it cannot show what the row renders beside an icon,
 * whether a long shell line overflows the transcript column, or whether the
 * tooltip still carries the path the label left out. So the dev lab mounts the
 * real `ToolStepRow` over the payloads a session actually carries — the same
 * JSON string `POST /api/sessions/{id}/messages` stores and the restore path
 * hands back — in three shapes: a drive-letter path, a long command with a path
 * inside it, and a UNC share.
 */
import { expect, test } from '@playwright/test';

test.describe('tool step rows at the transcript width', () => {
  test.beforeEach(async ({ page }) => {
    await page.route((url) => url.pathname.startsWith('/api/'), (route) =>
      route.fulfill({ status: 404, json: { error: 'Not found' } }),
    );
    await page.goto('/_design?lab=toolrows', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('lab-tool-rows')).toBeVisible();
  });

  test('labels show file names, and no absolute path is displayed', async ({ page }) => {
    test.setTimeout(90_000);
    const rows = page.getByTestId('lab-tool-rows');
    const read = await rows.evaluate((box) => {
      // The trigger's OWN text is the label the timeline builds through
      // getToolLabel — asserting only on childless nodes misses it, because the
      // trigger wraps an icon and a span. That blind spot let a real leak pass.
      const triggers = Array.from(box.querySelectorAll('button[aria-expanded], [role="button"]'))
        .map((e) => (e.textContent || '').trim())
        .filter((t) => t.length > 0 && t.length < 300);
      const leaves = Array.from(box.querySelectorAll('*'))
        .filter((e) => e.children.length === 0)
        .map((e) => (e.textContent || '').trim())
        .filter(Boolean);
      const abs = /[A-Za-z]:[\\/]|\\\\fileserver/;
      return {
        leafCount: leaves.length,
        visibleLeaves: leaves.slice(0, 20),
        triggerText: triggers.slice(0, 6),
        displayedPaths: [...leaves, ...triggers].filter((t) => abs.test(t)),
        commandRow: box.querySelector('[data-testid="command-inline-cmd"]')?.textContent?.trim() ?? null,
        commandTooltip: box.querySelector('[data-testid="command-inline-cmd"]')?.getAttribute('title') ?? null,
        width: Math.round(box.getBoundingClientRect().width),
      };
    });

    expect(read.displayedPaths, 'no absolute path may appear as row text or label').toEqual([]);
    expect(read.commandRow, 'the command row keeps the file names it touches')
      .toContain('overlays');
    expect(read.commandRow).not.toContain('C:/Dev');
    // The plan's other half: the value is not rewritten, only the display.
    expect(read.commandTooltip, 'the tooltip must still carry the verbatim line')
      .toContain('C:/Dev/august-proxy/frontend/desktop/src/components/overlays');
    expect(read.width, 'a long command must not widen the transcript column').toBe(420);
  });

  test('the Windows and UNC file names both render as names', async ({ page }) => {
    test.setTimeout(90_000);
    const rows = page.getByTestId('lab-tool-rows');
    const texts = await rows.evaluate((box) =>
      Array.from(box.querySelectorAll('*'))
        .filter((e) => e.children.length === 0)
        .map((e) => (e.textContent || '').trim()));
    expect(texts.filter((t) => t.includes('quarterly.xlsx')).length, 'xlsx name shown').toBeGreaterThan(0);
    expect(texts.filter((t) => t.includes('report.docx')).length, 'UNC leaf shown').toBeGreaterThan(0);
    expect(texts.some((t) => /Users|fileserver/.test(t) && /[\\/:]/.test(t) && t.length > 20),
      'no directory chain of either spelling should survive').toBe(false);
  });
});

test.describe('approval card title', () => {
  test('a pending run_command title carries no absolute path', async ({ page }) => {
    test.setTimeout(90_000);
    await page.route((url) => url.pathname.startsWith('/api/'), (route) =>
      route.fulfill({ status: 404, json: { error: 'Not found' } }),
    );
    await page.goto('/_design?lab=toolrows', { waitUntil: 'domcontentloaded' });
    const card = page.getByTestId('mutation-diff-cards');
    await expect(card).toBeVisible();
    const read = await card.evaluate((box) => {
      const leaves = Array.from(box.querySelectorAll('*'))
        .filter((e) => e.children.length === 0)
        .map((e) => (e.textContent || '').trim())
        .filter(Boolean);
      // The title is the label this component builds through getToolLabel. The
      // `$ …` line beside it is the verbatim command an approval has to show —
      // asserting over the whole card would demand the app hide exactly the text
      // a person needs before saying yes.
      const titles = leaves.filter((t) => /^(Ran|Running):/.test(t));
      return {
        titles,
        allText: (box.textContent || '').replace(/\s+/g, ' ').trim(),
        leakedTitles: titles.filter((t) => /[A-Za-z]:[\\/]/.test(t)),
      };
    });
    expect(read.titles.length, 'the card should render a built title').toBeGreaterThan(0);
    expect(read.leakedTitles, 'the approval card title must not print the path').toEqual([]);
    expect(read.allText, 'the exact command stays visible for approval').toContain('C:');
  });
});
