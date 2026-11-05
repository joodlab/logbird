// Recorded end-to-end walkthrough against the real local stack (`pnpm dev`, demo data): OTP sign-in via Mailpit → overview →
// explorer query → event detail → operation → impersonation search → actor/tenant profiles → retention preview → API keys →
// dark mode → Ledger project. Usage: OUT_DIR=<dir> [BASE_URL=http://localhost:4600] node scripts/walkthrough.mjs  (writes PNGs + walkthrough.webm, reports console/API errors)
import { mkdir, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { latestOtp, watch } from './qa-shoot.mjs';

const OUT = process.env.OUT_DIR;
const BASE = process.env.BASE_URL ?? 'http://localhost:4600';
const VIEW = { width: 1440, height: 900 };
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ slowMo: 60 });
const context = await browser.newContext({ viewport: VIEW, colorScheme: 'light', recordVideo: { dir: OUT, size: VIEW } });
const page = await context.newPage();
const problems = watch(page);
const log = (m) => console.log(`• ${m}`);
const settle = async (ms = 1500) => {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  await page
    .waitForFunction(() => document.querySelectorAll('[data-slot=skeleton]').length === 0, undefined, { timeout: 20_000 })
    .catch(() => undefined);
  await page.waitForTimeout(ms);
};
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const step = async (name, fn) => {
  try {
    await fn();
    log(`ok   ${name}`);
  } catch (e) {
    problems.push(`[step] ${name}: ${e.message.split('\n')[0]}`);
    log(`FAIL ${name}`);
  }
};

await step('sign in with OTP from Mailpit', async () => {
  await page.goto(`${BASE}/login`);
  await settle(800);
  await page.getByLabel('Work email').pressSequentially('demo@trailmark.local', { delay: 40 });
  await shot('01-login');
  const sentAt = Date.now() - 2000;
  await page.getByRole('button', { name: /continue with email/i }).click();
  const otp = page.getByRole('textbox', { name: 'One-time code' });
  await otp.waitFor();
  const code = await latestOtp('demo@trailmark.local', sentAt);
  await otp.click();
  await page.keyboard.type(code, { delay: 120 });
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
  await settle(2000);
});

const projects = await page.evaluate(async () => (await (await fetch('/api/projects')).json()).data);
const acme = projects.find((p) => p.slug === 'staydesk');
const P = `${BASE}/p/${acme.id}`;

await step('overview', async () => {
  await page.goto(`${P}?range=24h`);
  await settle(2500);
  await shot('02-overview');
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(1200);
  await page.mouse.wheel(0, -500);
});

await step('explorer query', async () => {
  await page.goto(`${P}/events?range=7d`);
  await settle(1500);
  const q = page.getByRole('combobox', { name: 'Query' });
  await q.click();
  await page.keyboard.type('outcome:failure category:whatsapp', { delay: 45 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await settle(2000);
  await shot('03-explorer-query');
});

await step('event detail + operation', async () => {
  await page.locator('[data-index]').first().click();
  await settle(1500);
  await shot('04-event-sheet');
  const op = page.getByRole('button', { name: /view operation/i }).or(page.getByRole('link', { name: /view operation/i }));
  await op.first().click();
  await settle(2000);
  await shot('05-operation');
});

await step('impersonation search', async () => {
  await page.goto(`${P}/events?range=30d&q=${encodeURIComponent('impersonator:*')}`);
  await settle(2000);
  await shot('06-impersonation');
});

await step('follow actor', async () => {
  await page.goto(`${P}/actors`);
  await settle(1500);
  await shot('07-actors');
  await page.locator('main a[href*="/actors/"]').first().click();
  await settle(2000);
  await shot('08-actor-profile');
});

await step('tenant profile', async () => {
  await page.goto(`${P}/tenants`);
  await settle(1200);
  await page.locator('main a[href*="/tenants/"]').first().click();
  await settle(2000);
  await shot('09-tenant-profile');
});

await step('retention preview', async () => {
  await page.goto(`${P}/settings/retention`);
  await settle(1500);
  await page
    .getByRole('radio', { name: /^30 days/ })
    .first()
    .click();
  await settle(1500);
  await shot('10-retention-preview');
  await page
    .getByRole('button', { name: 'Cancel' })
    .click()
    .catch(() => undefined);
});

await step('api keys', async () => {
  await page.goto(`${P}/settings/keys`);
  await settle(1500);
  await shot('11-api-keys');
});

await step('dark mode overview + explorer', async () => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${P}?range=7d`);
  await settle(2500);
  await shot('12-dark-overview');
  await page.goto(`${P}/events?range=24h`);
  await settle(1500);
  await page.locator('[data-index]').nth(2).click();
  await settle(1500);
  await shot('13-dark-event-sheet');
});

await step('ledger project (accept anything)', async () => {
  const ledger = projects.find((p) => p.slug === 'ledger-demo');
  await page.goto(`${BASE}/p/${ledger.id}?range=30d`);
  await settle(2500);
  await shot('14-dark-ledger');
});

await context.close();
await browser.close();
const vids = (await readdir(OUT)).filter((f) => f.endsWith('.webm'));
if (vids[0]) await rename(path.join(OUT, vids[0]), path.join(OUT, 'walkthrough.webm'));
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'NO PROBLEMS (no console errors, no failed /api calls)');
