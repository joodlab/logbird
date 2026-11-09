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
    await page.emulateMedia({ colorScheme: 'light' });
    await go('/events?range=7d');
    await page.getByRole('combobox', { name: 'Query', exact: true }).fill('outcome:');
    await page.getByRole('option').first().waitFor();
    await shot('query-suggestions-light');
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
    await shot('sql-rejected-light');
    await go('/tenants');
    await page.locator('main a[href*="/tenants/"]').first().click();
    await settle();
    await shot('tenant-light');
    await go('/actors');
    await page.locator('main a[href*="/actors/"]').first().click();
    await settle();
    await shot('actor-light');
    await go('/setup');
    await shot('setup-light');
    await go('/settings/retention');
    await shot('retention-light');
    await go('/events?range=7d&q=attempt:>1');
    await page.locator('[data-index]').first().click();
    await settle();
    await page.getByRole('button', { name: /view operation/i }).click();
    await settle();
    await shot('operation-light');
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
