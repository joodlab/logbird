/**
 * Evidence for the final-polish PR against the REAL stack (`pnpm dev` at the repo root, demo data seeded):
 * overview, actors directory, explorer with `impersonator:*` (+ the autocomplete that suggests it), the onboarding
 * name step and account settings, in light and dark at 1440×900, into marketing/captures/2026-11-04-final-polish/.
 *
 *   node scripts/capture-final-polish.mjs
 *
 * It also checks that every absolute timestamp is labelled with the one browser zone: hovering a pre-DST (October)
 * and a post-DST (November) event must both name the zone and neither may print a "GMT±n" offset.
 * The onboarding shot signs up a throwaway `newcomer-*@trailmark.local` user; run `pnpm demo:clean --yes` after.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { latestOtp, signIn, watch } from './qa-shoot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../../marketing/captures/2026-11-04-final-polish');
const BASE = process.env.BASE_URL ?? 'http://localhost:4600';
const DEMO = process.env.DEMO_EMAIL ?? 'demo@trailmark.local';
const TZ = process.env.TZ_ID ?? 'Europe/Berlin';
const VIEW = { width: 1440, height: 900 };
const problems = [];
const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

async function settle(page, ms = 1000) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  await page
    .waitForFunction(() => document.querySelectorAll('[data-slot=skeleton]').length === 0, undefined, { timeout: 20_000 })
    .catch(() => undefined);
  await page.waitForTimeout(ms);
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

// Demo session (once), reused for both themes.
const login = await browser.newContext({ viewport: VIEW, timezoneId: TZ });
const loginPage = await login.newPage();
await signIn(loginPage, DEMO);
await settle(loginPage);
const state = await login.storageState();
const projects = await loginPage.evaluate(async () => (await (await fetch('/api/projects')).json()).data);
await login.close();
const acme = projects.find((p) => p.slug === 'staydesk') ?? projects[0];
if (!acme) throw new Error('StayDesk demo project not found: run `pnpm demo` first.');

const zoneChecks = [];
for (const theme of ['light', 'dark']) {
  const context = await browser.newContext({ viewport: VIEW, colorScheme: theme, storageState: state, timezoneId: TZ });
  const page = await context.newPage();
  problems.push(...watch(page, () => `${theme} ${page.url().replace(BASE, '')}`));
  const p = `${BASE}/p/${acme.id}`;

  await page.goto(`${p}?range=24h`);
  await settle(page, 1800);
  await shot(page, `${theme}-overview`);

  await page.goto(`${p}/actors`);
  await settle(page);
  await shot(page, `${theme}-actors`);

  await page.goto(`${p}/events?range=7d&q=${encodeURIComponent('impersonator:*')}`);
  await settle(page, 1500);
  await shot(page, `${theme}-explorer-impersonator`);

  await page.goto(`${p}/events?range=7d`);
  await settle(page, 1200);
  await page.getByRole('combobox', { name: 'Query' }).click();
  await page.keyboard.type('imperson', { delay: 60 });
  await page.getByRole('option', { name: /impersonator:\*/ }).waitFor();
  await page.waitForTimeout(400);
  await shot(page, `${theme}-explorer-autocomplete`);
  await page.keyboard.press('Escape');

  await page.goto(`${BASE}/account`);
  await settle(page);
  await shot(page, `${theme}-account`);
  if (theme === 'light') {
    // Edit the name for real (better-auth updateUser), check the sidebar follows, then restore it.
    const input = page.getByLabel('Your name');
    const original = await input.inputValue();
    await input.fill(`${original} QA`);
    await page.getByRole('button', { name: 'Save name' }).click();
    await page.getByText('Name updated').waitFor();
    const sidebar = await page.locator('[data-sidebar=footer], [data-slot=sidebar-footer]').first().innerText();
    if (!sidebar.includes(`${original} QA`)) problems.push(`[name] sidebar did not update: ${sidebar}`);
    else console.log('👤 account rename reflected in the sidebar');
    await input.fill(original);
    await page.getByRole('button', { name: 'Save name' }).click();
    await page.waitForTimeout(800);
    const me = await page.evaluate(async () => (await (await fetch('/api/me')).json()).user.name);
    if (me !== original) problems.push(`[name] could not restore the demo name: ${me}`);
  }

  if (theme === 'light') {
    // One zone everywhere: an October (CEST) and a November (CET) event must carry the same zone label.
    for (const [label, range] of [
      ['october', '2026-10-14T08:00:00.000Z..2026-10-14T12:00:00.000Z'],
      ['november', '2026-11-04T08:00:00.000Z..2026-11-04T12:00:00.000Z'],
    ]) {
      await page.goto(`${p}/events?range=${encodeURIComponent(range)}`);
      await settle(page, 1200);
      const time = page.locator('[role=row] time, [data-index] time').first();
      await time.hover();
      const tip = page.locator('[data-slot=tooltip-content]').last();
      await tip.waitFor();
      const text = (await tip.innerText()).replace(/\s+/g, ' ');
      zoneChecks.push({ label, text });
      if (label === 'october') await shot(page, 'light-timestamp-tooltip');
      await page.mouse.move(5, 5);
      await page.waitForTimeout(300);
    }
    const body = await page.evaluate(() => document.body.innerText);
    if (/GMT[+-]\d/.test(body)) problems.push('[tz] page text still prints a GMT offset');
  }
  await context.close();
}
for (const z of zoneChecks) {
  console.log(`🕒 ${z.label}: ${z.text}`);
  if (!z.text.includes(TZ) || /GMT[+-]\d/.test(z.text)) problems.push(`[tz] ${z.label} tooltip not labelled with ${TZ}: ${z.text}`);
  if (!/UTC/.test(z.text)) problems.push(`[tz] ${z.label} tooltip has no UTC line`);
}

// Onboarding: a brand-new OTP user lands on the name step.
const email = `newcomer-${Date.now().toString(36)}@trailmark.local`;
for (const theme of ['light', 'dark']) {
  const context = await browser.newContext({ viewport: VIEW, colorScheme: theme, timezoneId: TZ });
  const page = await context.newPage();
  problems.push(...watch(page, () => `${theme} ${page.url().replace(BASE, '')}`));
  if (theme === 'light') {
    await page.goto(`${BASE}/login`);
    await page.getByLabel('Work email').fill(email);
    const sentAt = Date.now() - 2000;
    await page.getByRole('button', { name: /continue with email/i }).click();
    const otp = page.getByRole('textbox', { name: 'One-time code' });
    await otp.waitFor();
    const code = await latestOtp(email, sentAt);
    await otp.click();
    await page.keyboard.type(code, { delay: 60 });
  } else {
    await signIn(page, email);
  }
  await page.waitForURL((u) => u.pathname.startsWith('/onboarding/profile'), { timeout: 30_000 });
  await settle(page, 600);
  await page.getByLabel('Your name').click();
  await page.keyboard.type('Lina Haddad', { delay: 40 });
  await page.waitForTimeout(400);
  await shot(page, `${theme}-onboarding-name`);
  if (theme === 'dark') {
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL((u) => u.pathname === '/onboarding' || u.pathname === '/onboarding/', { timeout: 20_000 });
    await settle(page, 600);
    await shot(page, 'dark-onboarding-workspace-after-name');
    const me = await page.evaluate(async () => (await (await fetch('/api/me')).json()).user);
    if (me.name !== 'Lina Haddad') problems.push(`[name] updateUser did not persist: ${JSON.stringify(me.name)}`);
    else console.log('👤 name saved through better-auth updateUser:', me.name);
  }
  await context.close();
}
await browser.close();

console.log(`📸 ${OUT}`);
console.log(`🧹 throwaway user: ${email} (remove with \`pnpm demo:clean --yes\`)`);
if (problems.length) {
  console.log(problems.join('\n'));
  process.exitCode = 1;
} else console.log('No console warnings/errors, no failed /api requests, one time zone everywhere.');
