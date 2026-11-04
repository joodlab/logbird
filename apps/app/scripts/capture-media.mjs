/**
 * Captures the UI evidence committed under docs/media/ui-foundation/.
 *
 *   pnpm --filter @trailmark/app dev:fixtures      # terminal 1 (fixture mode, port 4600)
 *   pnpm --filter @trailmark/app media             # terminal 2
 *
 * Screenshots: every main page in light + dark at 1440×900, a few at 390×844.
 * Videos: sign-in → onboarding, explorer search/filter/detail, entity follow + operation tree,
 * retention change confirm.
 */
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../../docs/media/ui-foundation');
const BASE = process.env.BASE_URL ?? 'http://localhost:4600';
const P = '/p/prj_staydesk';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const only = process.argv.slice(2);
const want = (name) => only.length === 0 || only.includes(name);

const pause = (page, ms = 700) => page.waitForTimeout(ms);

async function settle(page, ms = 900) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await pause(page, ms);
}

async function signIn(page, email = 'demo@trailmark.local') {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Work email').fill(email);
  await pause(page, 250);
  await page.getByRole('button', { name: /continue with email/i }).click();
  const otp = page.getByRole('textbox', { name: 'One-time code' });
  await otp.waitFor();
  await otp.click();
  await page.keyboard.type('424242', { delay: 90 });
}

async function demoState(browser) {
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.evaluate(() => window.localStorage.clear());
  await signIn(page);
  await page.getByRole('heading', { name: 'Overview' }).waitFor({ timeout: 60_000 });
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

async function shoot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('  ✓', name);
}

async function screenshots(browser, storageState, scheme) {
  const ctx = await browser.newContext({ viewport: DESKTOP, colorScheme: scheme, storageState });
  const page = await ctx.newPage();
  const go = async (url, name, after) => {
    await page.goto(`${BASE}${url}`);
    await settle(page, 1400);
    if (after) await after();
    await shoot(page, `${scheme}-${name}`);
  };
  await go(`${P}`, 'overview');
  await go(`${P}/events`, 'explorer');
  await go(`${P}/events?q=action%3Ahotel.*`, 'explorer-autocomplete', async () => {
    await page.getByRole('combobox', { name: 'Query' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' outcome:', { delay: 40 });
    await pause(page, 900);
  });
  await go(`${P}/events?q=attr.metadata.supportTicket%3A*&range=30d`, 'event-detail', async () => {
    await page.locator('[role=row][data-index="0"]').click();
    await pause(page, 1600);
  });
  await go(`${P}/actors`, 'actors');
  await go(`${P}/actors/usr_42?range=7d`, 'actor-profile');
  await go(`${P}/tenants/biz_1?range=7d`, 'tenant-profile');
  await go(`${P}/workers`, 'workers');
  await go(`${P}/records/hotel:hotel_123?range=30d`, 'record-profile');
  // Find a multi-step operation from the CRM sync view.
  await page.goto(`${BASE}${P}/events?q=action%3Acrm.sync.failed&range=30d`);
  await settle(page, 1400);
  await page.locator('[role=row][data-index="0"]').click();
  await page.getByRole('button', { name: /view operation/i }).click();
  await settle(page, 1500);
  await shoot(page, `${scheme}-operation`);
  await go(`${P}/views`, 'saved-views');
  await go(`${P}/fields?range=7d`, 'fields');
  await go(`${P}/settings`, 'settings-general');
  await go(`${P}/settings/retention`, 'settings-retention-confirm', async () => {
    await page
      .getByRole('radio', { name: /^30 days/ })
      .first()
      .click();
    await page.getByRole('button', { name: /lower retention/i }).click();
    await pause(page, 600);
    await page.getByLabel(/to confirm/i).fill('staydesk');
    await pause(page, 400);
  });
  await go(`${P}/settings/keys`, 'settings-keys');
  await go(`${P}/settings/members`, 'settings-members');
  await go(`${P}/settings/activity`, 'workspace-activity');
  await go(`${P}/docs`, 'quickstart');
  await go(`${P}`, 'command-palette', async () => {
    await page.keyboard.press('Control+k');
    await page.keyboard.type('raed', { delay: 60 });
    await pause(page, 1200);
  });
  await ctx.close();

  const anon = await browser.newContext({ viewport: DESKTOP, colorScheme: scheme });
  const p2 = await anon.newPage();
  await p2.goto(`${BASE}/login`);
  await settle(p2);
  await shoot(p2, `${scheme}-login`);
  await p2.getByLabel('Work email').fill('demo@trailmark.local');
  await p2.getByRole('button', { name: /continue with email/i }).click();
  await p2.getByRole('textbox', { name: 'One-time code' }).waitFor();
  await p2.getByRole('textbox', { name: 'One-time code' }).click();
  await p2.keyboard.type('000000', { delay: 50 });
  await pause(p2, 900);
  await shoot(p2, `${scheme}-login-otp-error`);
  await anon.close();
}

async function phoneShots(browser, storageState) {
  const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState });
  const page = await ctx.newPage();
  for (const [url, name] of [
    [`${P}`, 'phone-overview'],
    [`${P}/events`, 'phone-explorer'],
    [`${P}/actors/usr_42?range=7d`, 'phone-actor'],
  ]) {
    await page.goto(`${BASE}${url}`);
    await settle(page, 1400);
    await shoot(page, name);
  }
  await page.goto(`${BASE}${P}/events?q=attr.metadata.supportTicket%3A*&range=30d`);
  await settle(page, 1400);
  await page.locator('[role=row][data-index="0"]').click();
  await pause(page, 1500);
  await shoot(page, 'phone-event-detail');
  await ctx.close();
}

async function video(browser, name, storageState, run) {
  const dir = path.join(OUT, `.video-${name}`);
  await rm(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir, size: { width: 1280, height: 800 } },
    storageState,
  });
  const page = await ctx.newPage();
  try {
    await run(page);
  } finally {
    await ctx.close();
  }
  const [file] = await readdir(dir);
  await rename(path.join(dir, file), path.join(OUT, `${name}.webm`));
  await rm(dir, { recursive: true, force: true });
  console.log('  ✓ video', name);
}

const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });
const state = await demoState(browser);

if (want('screens')) {
  for (const scheme of ['light', 'dark']) {
    console.log(`Screenshots (${scheme})`);
    await screenshots(browser, state, scheme);
  }
  console.log('Screenshots (phone)');
  await phoneShots(browser, state);
}

if (want('onboarding')) {
  await video(browser, 'signin-onboarding', undefined, async (page) => {
    await page.goto(`${BASE}/login`);
    await page.evaluate(() => window.localStorage.clear());
    await signIn(page, 'maya@acme.dev');
    await page.getByLabel('Workspace name').waitFor({ timeout: 30_000 });
    await pause(page, 900);
    await page.getByLabel('Workspace name').fill('');
    await page.getByLabel('Workspace name').pressSequentially('Acme Travel', { delay: 70 });
    await pause(page, 500);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await page.getByLabel('Project name').waitFor();
    await pause(page, 700);
    await page.getByLabel('Project name').pressSequentially('Booking API', { delay: 70 });
    await page
      .getByRole('radio', { name: /^1 year/ })
      .first()
      .click();
    await pause(page, 500);
    await page
      .getByRole('radio', { name: /^90 days/ })
      .first()
      .click();
    await pause(page, 400);
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByText('Listening for your first event').waitFor();
    await pause(page, 1500);
    await page.getByRole('tab', { name: 'curl' }).click();
    await pause(page, 1200);
    await page.getByRole('button', { name: 'Copy key' }).click();
    await pause(page, 800);
    await page.getByRole('button', { name: /send a test event/i }).click();
    await page.getByText('First event received').waitFor({ timeout: 20_000 });
    await pause(page, 1800);
    await page.getByRole('button', { name: /open overview/i }).click();
    await page.getByRole('heading', { name: 'Overview' }).waitFor();
    await pause(page, 2500);
  });
}

if (want('explorer')) {
  await video(browser, 'explorer-search-filter-zoom', state, async (page) => {
    await page.goto(`${BASE}${P}/events`);
    await settle(page, 1500);
    await page.keyboard.press('/');
    await page.keyboard.type('action:', { delay: 90 });
    await pause(page, 1000);
    await page.keyboard.type('booking', { delay: 90 });
    await pause(page, 800);
    await page.keyboard.press('Tab');
    await pause(page, 600);
    await page.keyboard.press('Enter');
    await settle(page, 1200);
    // ⌥-click excludes a facet value (here: staging), a plain click includes one.
    await page
      .getByRole('button', { name: /^staging/ })
      .first()
      .click({ modifiers: ['Alt'] })
      .catch(() => undefined);
    await settle(page, 1200);
    await page.getByRole('button', { name: /^info/ }).first().click();
    await settle(page, 1200);
    // drag-to-zoom on the histogram
    const chart = page.locator('.recharts-wrapper').first();
    const box = await chart.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.97, box.y + box.height * 0.5, { steps: 18 });
      await page.mouse.up();
      await settle(page, 1200);
    }
    await pause(page, 1500);
  });

  await video(browser, 'explorer-detail-live-tail', state, async (page) => {
    await page.goto(`${BASE}${P}/events?q=attr.metadata.supportTicket%3A*&range=30d`);
    await settle(page, 1500);
    await page.locator('[role=row][data-index="0"]').click();
    await pause(page, 2000);
    await page.keyboard.press('j');
    await pause(page, 1200);
    await page.keyboard.press('j');
    await pause(page, 1200);
    await page.getByText('Raw payload').click();
    await pause(page, 1500);
    await page.keyboard.press('Escape');
    await pause(page, 600);
    // Live tail needs a relative window: open the last 15 minutes, then stream.
    await page.goto(`${BASE}${P}/events?range=15m`);
    await settle(page, 1200);
    await page.getByRole('switch').first().click();
    await pause(page, 8000);
  });
}

if (want('entity')) {
  await video(browser, 'entity-follow-operation-tree', state, async (page) => {
    await page.goto(`${BASE}${P}/events?q=action%3Ahotel.policy.updated&range=30d`);
    await settle(page, 1500);
    await page.locator('[role=row][data-index="0"]').click();
    await pause(page, 1600);
    await page.getByRole('dialog').locator('a[href*="/actors/"]').first().click();
    await settle(page, 1800);
    await page.mouse.wheel(0, 700);
    await pause(page, 1500);
    await page.mouse.wheel(0, 700);
    await pause(page, 1500);
    await page.goto(`${BASE}${P}/events?q=action%3Acrm.sync.failed&range=30d`);
    await settle(page, 1400);
    await page.locator('[role=row][data-index="0"]').click();
    await pause(page, 1400);
    await page.getByRole('button', { name: /view operation/i }).click();
    await settle(page, 1800);
    await page.locator('section[aria-label="Causation tree"] li button').nth(2).click();
    await pause(page, 2200);
    await page.keyboard.press('Escape');
    await pause(page, 1200);
  });
}

if (want('retention')) {
  await video(browser, 'retention-change-confirm', state, async (page) => {
    await page.goto(`${BASE}${P}/settings/retention`);
    await settle(page, 1500);
    await page
      .getByRole('radio', { name: /^30 days/ })
      .first()
      .click();
    await pause(page, 1600);
    await page.getByRole('button', { name: /lower retention/i }).click();
    await pause(page, 1200);
    await page.getByLabel(/to confirm/i).pressSequentially('staydesk', { delay: 120 });
    await pause(page, 700);
    await page.getByRole('button', { name: /delete and lower/i }).click();
    await pause(page, 2500);
    await page.getByRole('link', { name: 'Workspace activity' }).first().click();
    await settle(page, 2500);
  });
}

await browser.close();
console.log(`Media written to ${OUT}`);
