// Recorded end-to-end walkthrough against the real local stack (`pnpm dev`, demo data): OTP sign-in via Mailpit → overview →
// explorer query → event detail → operation → impersonation search → actor/tenant profiles → retention preview → API keys →
// dark mode → Ledger project, then the query bar v2 flows (Query/SQL modes, autocomplete, inline errors, SQL saved view).
// Usage: OUT_DIR=<dir> [BASE_URL=http://localhost:4600] [STEPS=tour,query-bar] node scripts/walkthrough.mjs
// (writes PNGs + walkthrough.webm, reports console/API errors). STEPS=query-bar records only the query bar section.
import { mkdir, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { latestOtp, watch } from './qa-shoot.mjs';

const OUT = process.env.OUT_DIR;
const BASE = process.env.BASE_URL ?? 'http://localhost:4600';
const VIEW = { width: 1440, height: 900 };
const STEPS = new Set((process.env.STEPS ?? 'tour,query-bar').split(','));
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
const step = async (name, fn, section = 'tour') => {
  if (section !== 'always' && !STEPS.has(section)) return;
  try {
    await fn();
    log(`ok   ${name}`);
  } catch (e) {
    problems.push(`[step] ${name}: ${e.message.split('\n')[0]}`);
    log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
  }
};

await step(
  'sign in with OTP from Mailpit',
  async () => {
    if (!STEPS.has('tour')) {
      // Query-bar-only runs still sign in for real, just without the login screenshot pauses.
      await page.goto(`${BASE}/login`);
      await page.getByLabel('Work email').fill('demo@trailmark.local');
      const sentAt = Date.now() - 2000;
      await page.getByRole('button', { name: /continue with email/i }).click();
      const otp = page.getByRole('textbox', { name: 'One-time code' });
      await otp.waitFor();
      const code = await latestOtp('demo@trailmark.local', sentAt);
      await otp.click();
      await page.keyboard.type(code, { delay: 40 });
      await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
      await settle(1000);
      return;
    }
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
  },
  'always',
);

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

/* ------------------------------------------------------------------ */
/* Query bar v2: Query / SQL modes (STEPS=query-bar)                   */
/* ------------------------------------------------------------------ */

const bar = () => page.locator('textarea[role=combobox]');
const typeQuery = async (text, delay = 55) => {
  await bar().click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text, { delay });
};
const run = async () => {
  await page.keyboard.press('Control+Enter');
  await settle(1800);
};
const qb = (name, fn) => step(name, fn, 'query-bar');

await qb('query bar: key autocomplete + highlighting', async () => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${P}/events?range=7d`);
  await settle(1500);
  await typeQuery('action:booking.* -tenant:* act');
  await settle(500);
  await shot('qb-01-query-keys');
});

await qb('query bar: value autocomplete (actor names)', async () => {
  await typeQuery('outcome:success actor:');
  await page.keyboard.type('fai', { delay: 90 });
  await settle(900);
  await shot('qb-02-actor-values');
  await page.keyboard.press('Tab');
  await run();
});

await qb('query bar: advanced v2 query with results', async () => {
  await typeQuery(
    '(action:/crm\\.(bookings|guests)\\.sync\\.completed/ OR action:booking.*) attempt:>=2 conformance:[50 TO 100] -outcome:(failure OR denied)',
    18,
  );
  await run();
  await shot('qb-03-advanced-query');
});

await qb('query bar: inline error with span', async () => {
  await typeQuery('action:booking.* attempt:>abc');
  await run();
  await shot('qb-04-inline-error');
});

await qb('query bar: help cheat-sheet', async () => {
  await page.getByRole('button', { name: 'Query syntax help' }).click();
  await settle(500);
  await shot('qb-05-help');
  await page.keyboard.press('Escape');
});

await qb('query bar: switch to SQL translates simple terms', async () => {
  await typeQuery('outcome:failure actor.type:user');
  await run();
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  await settle(1500);
  await shot('qb-06-translated-to-sql');
});

await qb('query bar: SQL autocomplete (columns, attributes, values)', async () => {
  await typeQuery('job_at');
  await settle(400);
  await shot('qb-07-sql-columns');
  await page.keyboard.press('Tab');
  await page.keyboard.type(' >= 2 AND attri', { delay: 70 });
  await settle(400);
  await page.keyboard.press('Tab');
  await page.keyboard.type('queue', { delay: 90 });
  await settle(700);
  await shot('qb-08-sql-attribute-keys');
  await page.keyboard.press('Tab');
  await page.keyboard.type(" = '", { delay: 90 });
  await settle(900);
  await shot('qb-09-sql-values');
  await page.keyboard.press('Tab');
  await run();
  await shot('qb-10-sql-results');
});

await qb('query bar: rejected SQL (subquery)', async () => {
  await typeQuery('action IN (SELECT action FROM events)', 40);
  await run();
  await shot('qb-11-sql-rejected');
});

await qb('query bar: save + restore a SQL view', async () => {
  await typeQuery("job_attempt >= 2 AND attributes['metadata.queue'] = 'business-crm'", 15);
  await run();
  await page.getByRole('button', { name: /save view/i }).click();
  await page.getByLabel('Name').fill(`CRM retries (SQL) ${new Date().toISOString().slice(11, 19)}`);
  await settle(300);
  await shot('qb-12-save-sql-view');
  await page.getByRole('button', { name: 'Save view', exact: true }).last().click();
  await settle(1200);
  await page.goto(`${P}/views`);
  await settle(1200);
  await shot('qb-13-views-sql-badge');
  await page.locator('main li a').first().click();
  await settle(1800);
  await shot('qb-14-sql-view-restored');
  // Leave the shared demo project as we found it: drop the view this run created.
  const viewId = new URL(page.url()).searchParams.get('view');
  if (viewId) await page.evaluate(async ([pid, id]) => fetch(`/api/projects/${pid}/views/${id}`, { method: 'DELETE' }), [acme.id, viewId]);
});

await qb('query bar: dark mode + phone width', async () => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${P}/events?range=7d&lang=sql&q=${encodeURIComponent("job_attempt > 1 AND attributes['actor.role'] = 'admin'")}`);
  await settle(1500);
  await bar().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' AND has(tar', { delay: 70 });
  await settle(500);
  await shot('qb-15-dark-sql');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${P}/events?range=7d`);
  await settle(1500);
  await typeQuery('tenant.name:');
  await page.keyboard.type('ra', { delay: 90 });
  await settle(900);
  await shot('qb-16-phone');
  await page.setViewportSize(VIEW);
});

await context.close();
await browser.close();
const vids = (await readdir(OUT)).filter((f) => f.endsWith('.webm'));
if (vids[0]) await rename(path.join(OUT, vids[0]), path.join(OUT, 'walkthrough.webm'));
// The query bar section provokes two rejections on purpose (attempt:>abc, a SQL subquery): their 422s are expected.
const expected = (p) => /422/.test(p) && /attempt%3A%3Eabc|SELECT/.test(p);
const unexpected = problems.filter((p) => !expected(p));
console.log(
  unexpected.length ? `PROBLEMS:\n${unexpected.join('\n')}` : 'NO PROBLEMS (no console errors, no failed /api calls besides the intended 422s)',
);
