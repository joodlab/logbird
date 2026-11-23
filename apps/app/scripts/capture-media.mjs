/** Real StayDesk stills. Run from the repository root; see docs/media/README.md. */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { signIn, watch } from './qa-shoot.mjs';

// Reuse the site's declared media encoder without depending on its installation layout.
const sharp = createRequire(new URL('../../web/package.json', import.meta.url))('sharp');
const base = process.env.BASE_URL ?? 'http://localhost:4600';
const fixture = JSON.parse(await readFile('.tmp/media-fixture.json', 'utf8'));
const output = resolve(process.env.OUT_DIR ?? 'marketing/media/staydesk');
const videoOnly = process.env.CAPTURE_VIDEO === '1';
const view = { width: 1440, height: 900 };
await mkdir(output, { recursive: true });
await mkdir('.tmp/media-video', { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: view,
  colorScheme: 'light',
  // UTC, not the capturing machine's zone: the console labels times with the browser's time zone.
  timezoneId: 'UTC',
  locale: 'en-US',
  ...(videoOnly ? { recordVideo: { dir: '.tmp/media-video', size: view } } : {}),
});
const page = await context.newPage();
const problems = watch(page);
const p = `${base}/p/${fixture.projectId}`;
async function settle() {
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.querySelectorAll('[data-slot=skeleton]').length === 0);
  await page.waitForTimeout(400);
}
async function go(path) {
  await page.goto(`${p}${path}`);
  await settle();
}
async function crop(from, name, region) {
  await sharp(resolve(output, `${from}.webp`))
    .extract(region)
    .webp({ quality: 88 })
    .toFile(resolve(output, `${name}.webp`));
}
async function shot(name) {
  await sharp(await page.screenshot())
    .webp({ quality: 88 })
    .toFile(resolve(output, `${name}.webp`));
}
try {
  await signIn(page, fixture.email);
  await go('?range=7d');
  await page.getByText('StayDesk', { exact: true }).first().waitFor();
  if (videoOnly) {
    await page.waitForTimeout(1100);
    await page.getByRole('link', { name: 'Explorer', exact: true }).click();
    await settle();
    const query = page.getByRole('combobox', { name: 'Query', exact: true });
    await query.pressSequentially('action:booking.*', { delay: 35 });
    await query.press('Escape');
    await query.press('Enter');
    await settle();
    await page.locator('[data-index]').first().click();
    await page.getByRole('dialog').waitFor();
    await page.waitForTimeout(1600);
    await page.keyboard.press('Escape');
    await query.fill('');
    // Close the suggestions first: Enter on an empty bar with the panel open would run a suggested query.
    await query.press('Escape');
    await query.press('Enter');
    await page.getByRole('switch', { name: 'Live', exact: true }).click();
    for (let i = 0; i < 3; i++) {
      const response = await context.request.post(`${base}/v1/events`, {
        headers: { Authorization: `Bearer ${fixture.ingestKey}` },
        data: {
          action: 'booking.confirmed',
          description: `Live demo booking ${i + 1} confirmed`,
          actor: { type: 'user', id: 'demo-operator', name: 'Demo operator' },
          targets: [{ type: 'booking', id: `live-${Date.now()}-${i}`, name: `Demo reservation ${i + 1}` }],
          changes: [{ field: 'status', before: 'pending', after: 'confirmed' }],
        },
      });
      assert.equal(response.status(), 202);
      await page.waitForTimeout(600);
    }
    await page.getByText('Live demo booking 3 confirmed', { exact: false }).first().waitFor();
    await page.waitForTimeout(1200);
  } else {
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await go('?range=7d');
      await shot(`overview-${theme}`);
      await go('/events?range=7d&q=action:booking.*');
      await shot(`explorer-${theme}`);
      await page.locator('[data-index]').first().click();
      await settle();
      await shot(`event-sheet-${theme}`);
      // event-detail: the sheet panel of this capture, at the size the site uses (docs/media/README.md).
      await crop(`event-sheet-${theme}`, `event-detail-${theme}`, { left: 801, top: 0, width: 639, height: 860 });
      await page.keyboard.press('Escape');
      await go(`/events?range=7d&lang=sql&q=${encodeURIComponent("job_attempt > 1 AND outcome = 'success'")}`);
      await shot(`sql-${theme}`);
      await page.setViewportSize({ width: 390, height: 844 });
      await go('/events?range=7d&q=action:booking.*');
      await shot(`phone-explorer-${theme}`);
      await page.locator('[data-index]').first().click();
      await settle();
      await shot(`phone-event-sheet-${theme}`);
      await page.setViewportSize(view);
    }
    // These shots were light-only; the marketing site's dark theme needs real dark captures too. The light files keep
    // their paths and sizes; the dark ones are new files with the -dark suffix.
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await go('/events?range=7d');
      await page.getByRole('combobox', { name: 'Query', exact: true }).fill('outcome:');
      // Wait for real values with their counts, not an operator row shown while values load.
      await page
        .getByRole('option', { name: /success/ })
        .first()
        .waitFor();
      await page.getByText(/loading values/i).waitFor({ state: 'hidden' });
      await page.waitForTimeout(300);
      await shot(`query-suggestions-${theme}`);
      const rejectedAt = problems.length;
      await go(`/events?range=7d&lang=sql&q=${encodeURIComponent('action IN (SELECT action FROM events)')}`);
      await page
        .getByText(/subqueries are not allowed/i)
        .first()
        .waitFor();
      assert.ok(
        problems.slice(rejectedAt).every((problem) => problem.includes('422')),
        'Only expected SQL validation errors',
      );
      problems.splice(rejectedAt);
      await shot(`sql-rejected-${theme}`);
      await go('/tenants');
      await page.locator('main a[href*="/tenants/"]').first().click();
      await settle();
      await shot(`tenant-${theme}`);
      // tenant-summary: the account's header, counts and "who did it" from this capture (docs/media/README.md).
      await crop(`tenant-${theme}`, `tenant-summary-${theme}`, { left: 250, top: 70, width: 1160, height: 425 });
      await go('/actors');
      await page.locator('main a[href*="/actors/"]').first().click();
      await settle();
      await shot(`actor-${theme}`);
      await go('/setup');
      await shot(`setup-${theme}`);
      await go('/settings/retention');
      await shot(`retention-${theme}`);
      await go('/events?range=7d&q=attempt:>1');
      await page.locator('[data-index]').first().click();
      await settle();
      await page.getByRole('button', { name: /view operation/i }).click();
      await settle();
      await shot(`operation-${theme}`);
    }

    // The landing page's explorer: a visible query that shows people's actions rather than the scheduler's.
    // marketing (apps/web) compiles the same query in its tests.
    const heroQuery = '-actor.type:system';
    // The phone hero sits above the fold on a phone, so it is captured at 2x (780 x 1688) for high-density screens.
    const phoneHero = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      timezoneId: 'UTC',
      locale: 'en-US',
      storageState: await context.storageState(),
    });
    const phonePage = await phoneHero.newPage();
    const phoneProblems = watch(phonePage);
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await go(`/events?range=7d&q=${encodeURIComponent(heroQuery)}`);
      await shot(`explorer-hero-${theme}`);
      await phonePage.emulateMedia({ colorScheme: theme });
      await phonePage.goto(`${p}/events?range=7d&q=${encodeURIComponent(heroQuery)}`);
      await phonePage.waitForLoadState('networkidle');
      await phonePage.waitForFunction(() => document.querySelectorAll('[data-slot=skeleton]').length === 0);
      await phonePage.waitForTimeout(400);
      await sharp(await phonePage.screenshot())
        .webp({ quality: 88 })
        .toFile(resolve(output, `phone-explorer-hero-${theme}.webp`));
    }
    await phoneHero.close();
    problems.push(...phoneProblems);

    // A real completed evidence export: download it through the console's own API (the whole body, so the export
    // completes), then open its completed record in Workspace activity. Nothing on the page is edited.
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 3600 * 1000);
    const exportParams = new URLSearchParams({ format: 'jsonl-evidence', q: 'action:booking.*', from: from.toISOString(), to: to.toISOString() });
    const download = await page.request.get(`${base}/api/projects/${fixture.projectId}/export?${exportParams}`);
    assert.equal(download.status(), 200, 'The evidence export downloads');
    assert.ok((await download.body()).length > 0, 'The evidence export has rows');
    // This run's export id, from the download's filename: both themes open this export's own record, which can land in
    // Workspace activity a moment after the download ends.
    const exportId = /events-([0-9a-f-]{36})-evidence/.exec(download.headers()['content-disposition'] ?? '')?.[1];
    assert.ok(exportId, 'The download names its export id');
    const recordQuery = `action:export.completed ${exportId.slice(0, 8)}`;
    // The record's evidence (period, query, clock, SHA-256, size, rows) is its attributes. The attribute table truncates
    // long keys and the digest, so open the raw payload, scroll its attributes block to just under the sheet's sticky
    // header (the record's title and action), and keep the sheet from its top to the end of that block: one real,
    // contiguous region of the screen, legible at the size a marketing section allows.
    async function exportRecord(name) {
      let row;
      for (let attempt = 0; attempt < 10; attempt++) {
        await page.goto(`${base}/workspace/activity?q=${encodeURIComponent(recordQuery)}`);
        await settle();
        row = page
          .locator('[data-index]')
          .filter({ hasText: exportId.slice(0, 8) })
          .first();
        if (await row.count()) break;
        await page.waitForTimeout(1000);
      }
      await row.click();
      await settle();
      assert.ok(
        await page
          .getByRole('dialog')
          .getByText(`Export ${exportId.slice(0, 8)}`)
          .count(),
        "This run's export record is open",
      );
      const sheet = page.getByRole('dialog');
      await sheet.getByText(/raw payload/i).click();
      await page.waitForTimeout(400);
      const start = sheet.getByText('"attributes"', { exact: false }).last();
      // The raw payload has its own scroll area inside the sheet: bring its attributes block to the top of that area.
      await start.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(300);
      // Two real regions of the same screen, each cut on whole lines (maintainer on #289): the sheet's sticky header
      // (title, action, time), then the raw payload box from its "attributes" line to the last line fully inside it,
      // stopping at receivedBefore. The attribute table between them is left out.
      const regions = await start.evaluate((el) => {
        const sheetEl = el.closest('[role=dialog]');
        const curl = [...sheetEl.querySelectorAll('button')].find((b) => /copy as curl/i.test(b.textContent ?? ''));
        const boxEl = el.closest('[class*="max-h-"]');
        const top = sheetEl.getBoundingClientRect().top;
        const left = sheetEl.getBoundingClientRect().left;
        const boxRect = boxEl.getBoundingClientRect();
        // JSON lines are the innermost .ps-4 rows; keep those fully inside the box, up to receivedBefore.
        const lines = [...boxEl.querySelectorAll('div.ps-4')].filter((row) => !row.querySelector('div.ps-4'));
        let end = boxRect.top;
        for (const row of lines) {
          const r = row.getBoundingClientRect();
          if (r.top < boxRect.top - 1 || r.bottom > boxRect.bottom - 1) continue;
          end = Math.max(end, r.bottom);
          if (/receivedBefore/.test(row.textContent ?? '')) break;
        }
        return {
          header: { top: 0, height: Math.round(curl.getBoundingClientRect().bottom + 12 - top) },
          box: {
            left: Math.round(boxRect.left - left),
            top: Math.round(boxRect.top - top),
            width: Math.round(boxRect.width),
            height: Math.round(end + 2 - boxRect.top),
          },
          width: Math.round(sheetEl.getBoundingClientRect().width),
        };
      });
      const full = await sheet.screenshot();
      const header = await sharp(full).extract({ left: 0, top: 0, width: regions.width, height: regions.header.height }).toBuffer();
      const box = await sharp(full)
        .extract({ left: regions.box.left, top: regions.box.top, width: regions.box.width, height: regions.box.height })
        .toBuffer();
      // The gap between the two regions takes the sheet's own background, sampled beside the header.
      const { data } = await sharp(full)
        .extract({ left: 2, top: regions.header.height - 2, width: 1, height: 1 })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const background = { r: data[0], g: data[1], b: data[2], alpha: 1 };
      await sharp(header)
        .extend({ bottom: regions.box.height + 16, background })
        .composite([{ input: box, top: regions.header.height + 8, left: regions.box.left }])
        .webp({ quality: 88 })
        .toFile(resolve(output, `${name}.webp`));
    }
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await exportRecord(`export-record-${theme}`);
      await page.setViewportSize({ width: 390, height: 844 });
      await exportRecord(`phone-export-record-${theme}`);
      await page.setViewportSize(view);
    }
  }
  assert.deepEqual(
    problems.filter((problem) => !problem.startsWith('[warning]')),
    [],
    'Capture must have no console or API errors',
  );
  console.log('Real-service capture completed.');
} finally {
  const video = page.video();
  await context.close();
  if (video) await video.saveAs('.tmp/media-video/walkthrough.webm');
  await browser.close();
}
