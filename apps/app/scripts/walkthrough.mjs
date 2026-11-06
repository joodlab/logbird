// Recorded end-to-end walkthrough against the real local stack (`pnpm dev`, demo data): OTP sign-in via Mailpit → overview →
// explorer query → event detail → operation → impersonation search → actor/tenant profiles → retention preview → API keys →
// dark mode → Ledger project, then the query bar v3 flows (suggestions on focus — recent queries, saved views, fields —,
// values ranked by count, entity matches, operators, Lucene/KQL conversions, mid-query edits, SQL suggestions with
// signatures, inline errors, SQL saved view) and a separately recorded investigation built only from suggestions in
// both modes (query-investigation.webm).
// Then setup & onboarding sections, each in its own (recorded) browser context with fresh throwaway users:
//   onboarding  brand-new user → You → Workspace → Project → leave and come back (resumes) → inline ingest key → real `curl`
//               while the first-event step polls → celebration + received event → overview checklist → Setup envelope
//               hints → "Find missing" opens the explorer                                            (onboarding.webm)
//   setup       /docs redirect, retention "Looks good", inline read key, sample data load/remove, dismiss the overview
//               card and reopen it from Setup, sidebar progress in icon mode                              (setup.webm)
//   invite      invite an admin → rendered email in Mailpit → wrong-account state → second user accepts in a separate
//               context (OTP) → names themselves → lands in the workspace; cancel another invite → canceled state
//                                                                                                  (invite-accept.webm)
// Usage: OUT_DIR=<dir> [BASE_URL=http://localhost:4600] [STEPS=tour,query-bar,onboarding,setup,invite] node scripts/walkthrough.mjs
// (writes PNGs + webm recordings, reports console/API errors). STEPS=query-bar records only the query bar section.
import { execFile } from 'node:child_process';
import { mkdir, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { latestOtp, watch } from './qa-shoot.mjs';

const OUT = process.env.OUT_DIR;
const BASE = process.env.BASE_URL ?? 'http://localhost:4600';
const VIEW = { width: 1440, height: 900 };
const STEPS = new Set((process.env.STEPS ?? 'tour,query-bar,onboarding,setup,invite').split(','));
const MAILPIT = process.env.MAILPIT_API ?? 'http://127.0.0.1:8025';
const RUN = Date.now().toString(36);
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
    await shot(`FAIL-${name.replace(/[^\w-]+/g, '-').slice(0, 60)}`).catch(() => undefined);
  }
};

await step(
  'sign in with OTP from Mailpit',
  async () => {
    if (!STEPS.has('tour')) {
      // Query-bar-only runs still sign in for real, just without the login screenshot pauses.
      await page.goto(`${BASE}/login`);
      await page.getByLabel('Work email').fill('demo@logbird.local');
      const sentAt = Date.now() - 2000;
      await page.getByRole('button', { name: /continue with email/i }).click();
      const otp = page.getByRole('textbox', { name: 'One-time code' });
      await otp.waitFor();
      const code = await latestOtp('demo@logbird.local', sentAt);
      await otp.click();
      await page.keyboard.type(code, { delay: 40 });
      await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
      await settle(1000);
      return;
    }
    await page.goto(`${BASE}/login`);
    await settle(800);
    await page.getByLabel('Work email').pressSequentially('demo@logbird.local', { delay: 40 });
    await shot('01-login');
    const sentAt = Date.now() - 2000;
    await page.getByRole('button', { name: /continue with email/i }).click();
    const otp = page.getByRole('textbox', { name: 'One-time code' });
    await otp.waitFor();
    const code = await latestOtp('demo@logbird.local', sentAt);
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
/* Query bar v3: suggestions, Query / SQL modes (STEPS=query-bar)      */
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
/** Suggestion panel rows, for asserting what the panel offers. */
const options = () => page.locator('[data-slot=query-suggestions] [role=option]');
const expectOption = async (text) => {
  await options().filter({ hasText: text }).first().waitFor({ timeout: 8000 });
};
const qb = (name, fn) => step(name, fn, 'query-bar');
let tempView = null;

await qb('query bar: focus shows recent queries, saved views and top fields', async () => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${P}/events?range=7d`);
  await settle(1500);
  // Two runs make two recent queries; a saved view (removed again at the end) shows up next to them.
  await typeQuery('outcome:failure attempt:>1');
  await run();
  await typeQuery('action:booking.* -tenant:*');
  await run();
  tempView = await page.evaluate(
    async (pid) =>
      (
        await fetch(`/api/projects/${pid}/views`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: `Failed CRM syncs (walkthrough ${new Date().toISOString().slice(11, 19)})`,
            description: null,
            state: { q: 'outcome:failure action:business-crm.*', range: '7d' },
          }),
        })
      ).json(),
    acme.id,
  );
  await page.goto(`${P}/events?range=7d`);
  await settle(1200);
  await bar().click();
  await expectOption('action:booking.* -tenant:*');
  await expectOption('Failed CRM syncs');
  await page.waitForTimeout(400);
  await shot('qb-01-focus-recent-views-fields');
});

await qb('query bar: fuzzy field names with type, coverage and description', async () => {
  await typeQuery('tnm');
  await expectOption('tenant.name');
  await shot('qb-02-fuzzy-fields');
});

await qb('query bar: values ranked by count, then value operators', async () => {
  await typeQuery('outcome:');
  await expectOption('failure');
  await shot('qb-03-values-and-operators');
});

await qb('query bar: free text finds entities by name (rawd → Rawda Suites)', async () => {
  await typeQuery('outcome:failure rawd');
  await expectOption('Rawda Suites');
  await shot('qb-04-entity-match');
});

await qb('query bar: number operators and date quick ranges', async () => {
  await typeQuery('attempt:');
  await expectOption('Greater than');
  await shot('qb-05-number-operators');
  await typeQuery('occurredAt:');
  await expectOption('Last 7 days');
  await shot('qb-06-date-quick-ranges');
});

await qb('query bar: boolean operators lead after a complete term', async () => {
  await typeQuery('outcome:failure ');
  await expectOption('Either side matches');
  await shot('qb-07-after-term-operators');
  await typeQuery('outcome:(failure ');
  await expectOption('Any of these values');
  await shot('qb-08-group-or');
});

await qb('query bar: editing mid-query replaces only the token under the caret', async () => {
  await typeQuery('outcome:failure tenant:biz_2 attempt:>1');
  await page.keyboard.press('Home');
  for (let i = 0; i < 'outcome:'.length; i += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+Space');
  await expectOption('partial');
  await shot('qb-09-mid-query-edit');
  await options().filter({ hasText: 'partial' }).first().hover();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
  const value = await bar().inputValue();
  if (value !== 'outcome:partial tenant:biz_2 attempt:>1') throw new Error(`mid-query edit produced: ${value}`);
  await page.keyboard.press('Escape');
  await shot('qb-10-mid-query-replaced');
});

await qb('query bar: Lucene / KQL spellings are offered and converted', async () => {
  await typeQuery('tenant = biz_2 && _exists_:impersonator');
  await page.keyboard.press('Home');
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+Space');
  await expectOption('tenant:biz_2');
  await shot('qb-11-kql-did-you-mean');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await settle(1800);
  const value = await bar().inputValue();
  if (value !== 'tenant:biz_2 AND impersonator:*') throw new Error(`conversion produced: ${value}`);
  await shot('qb-12-kql-converted');
});

await qb('query bar: inline error with span', async () => {
  await typeQuery('action:booking.* attempt:>abc');
  await run();
  await shot('qb-13-inline-error');
});

await qb('query bar: help cheat-sheet', async () => {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Query syntax help' }).click();
  await settle(500);
  await shot('qb-14-help');
  await page.keyboard.press('Escape');
});

await qb('query bar: switch to SQL translates simple terms', async () => {
  await typeQuery('outcome:failure actor.type:user');
  await run();
  await page.getByRole('button', { name: 'SQL', exact: true }).click();
  await settle(1500);
  await shot('qb-15-translated-to-sql');
});

await qb('query bar: SQL suggestions (operators, values, attribute keys, signatures, time)', async () => {
  await typeQuery('outcome ');
  await expectOption('IN (…)');
  await shot('qb-16-sql-compare-operators');
  await page.keyboard.press('Tab');
  await expectOption('failure');
  await shot('qb-17-sql-values');
  await typeQuery('job_attempt >= 2 AND queue');
  await expectOption("attributes['metadata.queue']");
  await shot('qb-18-sql-attribute-by-name');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expectOption('business-crm');
  await page.keyboard.type('crm', { delay: 70 });
  await page.keyboard.press('Tab');
  await page.keyboard.type(' ', { delay: 70 });
  await expectOption('AND');
  await shot('qb-19-sql-combine');
  await page.keyboard.press('Tab');
  await page.keyboard.type('has(target_types, ', { delay: 50 });
  await expectOption('booking');
  await shot('qb-20-sql-signature-values');
  await typeQuery('timestamp > ');
  await expectOption('INTERVAL 7 DAY');
  await shot('qb-21-sql-time');
  await typeQuery("job_attempt >= 2 AND attributes['metadata.queue'] = 'business-crm'", 15);
  await run();
  await shot('qb-22-sql-results');
});

await qb('query bar: rejected SQL (subquery)', async () => {
  await typeQuery('action IN (SELECT action FROM events)', 40);
  await run();
  await shot('qb-23-sql-rejected');
});

await qb('query bar: save + restore a SQL view', async () => {
  await typeQuery("job_attempt >= 2 AND attributes['metadata.queue'] = 'business-crm'", 15);
  await run();
  await page.getByRole('button', { name: /save view/i }).click();
  const name = `CRM retries (SQL) ${new Date().toISOString().slice(11, 19)}`;
  await page.getByLabel('Name').fill(name);
  await settle(300);
  await shot('qb-24-save-sql-view');
  await page.getByRole('button', { name: 'Save view', exact: true }).last().click();
  await settle(1200);
  await page.goto(`${P}/views`);
  await settle(1200);
  await shot('qb-25-views-sql-badge');
  await page.locator('main li a', { hasText: name }).first().click();
  await settle(1800);
  await shot('qb-26-sql-view-restored');
  // Leave the shared demo project as we found it: drop the view this run created (by name, not list position).
  const views = await (await context.request.get(`${BASE}/api/projects/${acme.id}/views`)).json();
  for (const v of views.data ?? views) if (v.name === name) await context.request.delete(`${BASE}/api/projects/${acme.id}/views/${v.id}`);
});

await qb('query bar: forget a recent query (Shift+Delete)', async () => {
  await page.goto(`${P}/events?range=7d`);
  await settle(1200);
  await bar().click();
  // The highlighted first row is the newest recent query; Shift+Delete forgets it.
  const first = options().first();
  await first.waitFor();
  if ((await first.getAttribute('aria-selected')) !== 'true') throw new Error('first row is not highlighted');
  const text = (await first.locator('span').first().textContent())?.trim() ?? '';
  const recent = page.locator('[data-slot=query-suggestions] [role=option]', { has: page.getByRole('button', { name: `Forget ${text}` }) });
  if ((await recent.count()) !== 1) throw new Error(`first row is not a recent query: ${text}`);
  await page.keyboard.press('Shift+Delete');
  await page.waitForTimeout(400);
  if ((await recent.count()) !== 0) throw new Error(`recent not removed: ${text}`);
  await shot('qb-27-recent-forgotten');
  await page.keyboard.press('Escape');
});

await qb('query bar: dark mode + phone width', async () => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${P}/events?range=7d&lang=sql&q=${encodeURIComponent("job_attempt > 1 AND attributes['actor.role'] = 'admin'")}`);
  await settle(1500);
  await bar().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' AND has(tar', { delay: 70 });
  await settle(500);
  await shot('qb-28-dark-sql');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${P}/events?range=7d`);
  await settle(1500);
  await typeQuery('tenant.name:');
  await page.keyboard.type('ra', { delay: 90 });
  await settle(900);
  await shot('qb-29-phone');
  await page.setViewportSize(VIEW);
  await page.keyboard.press('Escape');
});

/*
 * The investigation, recorded on its own (query-investigation.webm): "failed CRM booking syncs for one tenant,
 * retried more than once, in the last 7 days" typed from an empty bar using only suggestions — a few letters to
 * narrow, Tab / ↓ to pick — first in the query language, then in SQL mode.
 */
await qb('query bar: investigation from empty using only suggestions (Query, then SQL)', async () => {
  const s = await session('query-investigation', { storageState: await context.storageState() });
  const p = s.page;
  const field = () => p.locator('textarea[role=combobox]');
  const press = async (k, pause = 550) => {
    await p.keyboard.press(k);
    await p.waitForTimeout(pause);
  };
  const keys = async (t, pause = 650) => {
    await p.keyboard.type(t, { delay: 120 });
    await p.waitForTimeout(pause);
  };
  const want = async (text) => {
    await p.locator('[data-slot=query-suggestions] [role=option]').filter({ hasText: text }).first().waitFor({ timeout: 8000 });
    await p.waitForTimeout(350);
  };
  await s.step('query language', async () => {
    await p.goto(`${P}/events?range=7d`);
    await s.settle(1500);
    await field().click();
    await p.waitForTimeout(1200);
    await keys('out');
    await press('Tab');
    await want('failure');
    await keys('fa');
    await press('Tab', 900); // outcome:failure — operators lead after a complete term
    await keys('jobn');
    await press('Tab');
    await want('crm:sync:bookings');
    await keys('book');
    await press('Tab', 800); // metadata.jobName:"crm:sync:bookings" (quoted: the value has colons)
    await keys('rawd');
    await want('Rawda Suites');
    await press('Tab', 800); // tenant:biz_2
    await keys('att');
    await press('Tab');
    await want('Greater than');
    await press('Tab'); // attempt:>
    await keys('1 ', 800);
    await keys('occ');
    await press('Tab');
    await want('Last 7 days');
    await press('ArrowDown');
    await press('Tab', 900);
    const q = await field().inputValue();
    if (!/^outcome:failure metadata\.jobName:"crm:sync:bookings" tenant:biz_2 attempt:>1 occurredAt:>\d{4}-\d{2}-\d{2} $/.test(q)) {
      throw new Error(`query built: ${q}`);
    }
    await s.shot('qb-inv-01-query-built');
    await press('Enter');
    await s.settle(2200);
    await s.shot('qb-inv-02-query-results');
  });
  await s.step('SQL mode', async () => {
    await p.getByRole('button', { name: 'Clear query' }).click();
    await s.settle(800);
    await p.getByRole('button', { name: 'SQL', exact: true }).click();
    await s.settle(1200);
    await field().click();
    await p.waitForTimeout(1000);
    await keys('out');
    await press('Tab'); // outcome → comparison operators
    await want('IN (…)');
    await press('Tab'); // =
    await want('failure');
    await keys('fa');
    await press('Tab'); // 'failure'
    await keys(' ');
    await want('AND');
    await press('Tab');
    await keys('jobn');
    await want("attributes['metadata.jobName']");
    await press('Tab');
    await press('Tab'); // =
    await want('crm:sync:bookings');
    await keys('book');
    await press('Tab');
    await keys(' ');
    await press('Tab'); // AND
    await keys('tenant_i');
    await press('Tab');
    await press('Tab'); // tenant_id =
    await keys('rawd');
    await want('Rawda Suites');
    await press('Tab'); // 'biz_2'
    await keys(' ');
    await press('Tab'); // AND
    await keys('job_at');
    await press('Tab');
    await keys('> 1 ');
    await want('AND');
    await press('Tab');
    await keys('timest');
    await press('Tab');
    await keys('>');
    await want('INTERVAL 7 DAY');
    await press('ArrowDown');
    await press('Tab', 900);
    const q = await field().inputValue();
    const expected =
      "outcome = 'failure' AND attributes['metadata.jobName'] = 'crm:sync:bookings' AND tenant_id = 'biz_2' AND job_attempt > 1 AND timestamp > now() - INTERVAL 7 DAY ";
    if (q !== expected) throw new Error(`SQL built: ${q}`);
    await s.shot('qb-inv-03-sql-built');
    await press('Enter');
    await s.settle(2200);
    await s.shot('qb-inv-04-sql-results');
  });
  await s.close();
});

// Remove the saved view created for the focus screenshot.
if (tempView?.id) await context.request.delete(`${BASE}/api/projects/${acme.id}/views/${tempView.id}`).catch(() => undefined);

await context.close();
const vids = (await readdir(OUT)).filter((f) => f.endsWith('.webm'));
if (vids[0]) await rename(path.join(OUT, vids[0]), path.join(OUT, 'walkthrough.webm'));

/* ------------------------------------------------------------------ */
/* Setup & onboarding (STEPS=onboarding,setup,invite)                  */
/* ------------------------------------------------------------------ */

/** One browser context per flow (optionally recorded), with the shared screenshot/settle/step helpers. */
async function session(label, { video = true, storageState } = {}) {
  const dir = path.join(OUT, `.video-${label}`);
  const context = await browser.newContext({
    viewport: VIEW,
    colorScheme: 'light',
    storageState,
    recordVideo: video ? { dir, size: VIEW } : undefined,
  });
  const page = await context.newPage();
  const seen = watch(page, () => `[${label}] ${page.url().replace(BASE, '')}`);
  const settle = async (ms = 1500) => {
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
    await page
      .waitForFunction(() => document.querySelectorAll('[data-slot=skeleton]').length === 0, undefined, { timeout: 20_000 })
      .catch(() => undefined);
    await page.waitForTimeout(ms);
  };
  const shot = (name, options = {}) => page.screenshot({ path: path.join(OUT, `${name}.png`), ...options });
  const step = async (name, fn) => {
    try {
      await fn();
      log(`ok   [${label}] ${name}`);
    } catch (e) {
      problems.push(`[step] ${label}: ${name}: ${e.message.split('\n')[0]}`);
      log(`FAIL [${label}] ${name}`);
      await shot(`FAIL-${label}-${name.replace(/[^\w-]+/g, '-').slice(0, 60)}`).catch(() => undefined);
    }
  };
  const close = async () => {
    problems.push(...seen);
    await context.close();
    if (!video) return;
    const vids = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.webm'));
    if (vids[0]) await rename(path.join(dir, vids[0]), path.join(OUT, `${label}.webm`));
  };
  return { context, page, settle, shot, step, close };
}

/** OTP sign-in through the real form, reading the code from Mailpit. */
async function signIn(page, email) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Work email').pressSequentially(email, { delay: 25 });
  const sentAt = Date.now() - 2000;
  await page.getByRole('button', { name: /continue with email/i }).click();
  const otp = page.getByRole('textbox', { name: 'One-time code' });
  await otp.waitFor();
  const code = await latestOtp(email, sentAt);
  await otp.click();
  await page.keyboard.type(code, { delay: 80 });
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
}

async function latestMail(to, after) {
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}&limit=5`)).json();
    const msg = (list.messages ?? []).find((m) => Date.parse(m.Created) >= after);
    if (msg) return (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)).json();
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No email for ${to} in Mailpit`);
}

/* ------------------------------------------------------------------ */
/* onboarding: a brand-new user, first event via real curl             */
/* ------------------------------------------------------------------ */
const owner = { email: `setup-owner-${RUN}@logbird.local`, state: path.join(OUT, `.state-owner-${RUN}.json`), projectId: '' };

async function onboarding() {
  const { context, page, settle, shot, step, close } = await session('onboarding');
  await step('new user signs in and lands on the profile step', async () => {
    await signIn(page, owner.email);
    await page.waitForURL(/\/onboarding\/profile/);
    await settle(800);
    await page.getByLabel('Your name').pressSequentially('Rana Setup', { delay: 30 });
    await shot('20-onboarding-profile');
    await page.getByRole('button', { name: /continue/i }).click();
  });
  await step('workspace step, then project step', async () => {
    await page.waitForURL(/\/onboarding\/?$/);
    await page.getByLabel('Workspace name').fill(`Setup QA ${RUN}`);
    await page.getByRole('button', { name: /create workspace/i }).click();
    await page.waitForURL(/onboarding\/project/);
    await settle(600);
    await page.getByLabel('Project name').pressSequentially('Bookings API', { delay: 30 });
    await shot('21-onboarding-project');
  });
  await step('leaving and coming back resumes at the missing step', async () => {
    await page.goto(`${BASE}/`);
    await page.waitForURL(/onboarding\/project/);
    await page.getByLabel('Project name').fill('Bookings API');
    await page.getByRole('button', { name: /create project/i }).click();
    await page.waitForURL(/onboarding\/first-event\//);
    owner.projectId = page.url().split('/').pop();
    await settle(1200);
    await page.goto(`${BASE}/`);
    await page.waitForURL(/onboarding\/first-event\//);
    await settle(1200);
  });
  let secret = '';
  await step('create an ingest key inline (secret shown once)', async () => {
    await page.getByRole('button', { name: /create another ingest key/i }).click();
    await page.getByRole('button', { name: /^create ingest key/i }).click();
    secret = (await page.getByTestId('ingest-secret').textContent())?.trim() ?? '';
    if (!secret.startsWith('lb_ingest_')) throw new Error('no secret revealed');
    await page.getByTestId('first-event-listening').scrollIntoViewIfNeeded();
    await settle(600);
    await shot('22-first-event-listening');
  });
  await step('real curl while the page polls → celebration + received event', async () => {
    const event = {
      action: 'booking.created',
      outcome: 'success',
      description: 'Lina created booking BK-1042 for Azure Hotels',
      actor: { type: 'user', id: 'usr_lina', name: 'Lina Haddad' },
      tenant: { id: 'biz_7', name: 'Azure Hotels' },
      targets: [{ type: 'booking', id: 'BK-1042', name: 'Booking BK-1042' }],
    };
    const curl = ['-sS', '-X', 'POST', `${BASE}/v1/events`, '-H', `Authorization: Bearer ${secret}`, '-H', 'Content-Type: application/json'];
    const { stdout } = await promisify(execFile)('curl', [...curl, '-d', JSON.stringify(event)]);
    log(`     curl → ${stdout.trim()}`);
    const t0 = Date.now();
    await page.getByTestId('first-event-received').waitFor({ timeout: 20_000 });
    log(`     first event shown ${Date.now() - t0} ms after curl returned`);
    await page.waitForTimeout(500);
    await shot('23-first-event-received');
    await page.getByRole('button', { name: /event details/i }).click();
    await settle(1200);
    await shot('24-first-event-sheet');
    await page.keyboard.press('Escape');
  });
  await step('overview: compact checklist + sidebar progress, expand', async () => {
    await page.getByRole('button', { name: /continue to overview/i }).click();
    await page.waitForURL(/\/p\/[^/]+$/);
    await settle(2000);
    await shot('25-overview-checklist');
    await page.getByRole('button', { name: /show all steps/i }).click();
    await page.waitForTimeout(600);
    await shot('26-overview-checklist-expanded');
    await page.getByRole('button', { name: /collapse checklist/i }).click();
  });
  await step('setup page: envelope hints → "Find missing" opens the explorer', async () => {
    await page
      .getByTestId('setup-checklist')
      .getByText(/see what is missing/i)
      .first()
      .click();
    await page.waitForURL(/\/setup/);
    await settle(1500);
    await page.getByTestId('step-envelope').scrollIntoViewIfNeeded();
    await shot('27-setup-envelope');
    await page
      .getByTestId('envelope-fields')
      .getByRole('link', { name: /find missing/i })
      .first()
      .click();
    await page.waitForURL(/\/events\?/);
    await settle(1500);
    const q = new URL(page.url()).searchParams.get('q');
    if (!q?.startsWith('-')) throw new Error(`unexpected explorer query ${q}`);
    log(`     explorer opened with q=${q}`);
    await shot('28-explorer-missing-field');
  });
  await context.storageState({ path: owner.state });
  await close();
}

/* ------------------------------------------------------------------ */
/* setup: actions on the Setup page                                    */
/* ------------------------------------------------------------------ */
async function setup() {
  const { page, settle, shot, step, close } = await session('setup', { storageState: owner.state });
  const P = `${BASE}/p/${owner.projectId}`;
  await step('/docs redirects to /setup', async () => {
    await page.goto(`${P}/docs#query`);
    await page.waitForURL(/\/setup#query/);
  });
  await step('retention "Looks good"', async () => {
    await page.goto(`${P}/setup#retention`);
    await settle(1200);
    await page
      .getByTestId('step-retention')
      .getByRole('button', { name: /looks good/i })
      .click();
    await page.locator('[data-testid=step-retention][data-status=done]').waitFor();
  });
  await step('inline read key + read snippet', async () => {
    await page.goto(`${P}/setup#read-key`);
    await settle(1200);
    await page
      .getByTestId('step-read_key')
      .getByRole('button', { name: /create read key/i })
      .click();
    await page.getByTestId('read-secret').waitFor();
    await settle(800);
    await page.getByTestId('step-read_key').scrollIntoViewIfNeeded();
    await shot('30-setup-read-key');
  });
  await step('sample data loads, never counts, and is removable', async () => {
    await page.goto(`${P}/setup#first-event`);
    await settle(1200);
    const sample = page.getByTestId('step-first_event').getByTestId('sample-data');
    await sample.getByRole('button', { name: /load sample data/i }).click();
    await sample.getByText(/sample events loaded/).waitFor({ timeout: 60_000 });
    await sample.scrollIntoViewIfNeeded();
    await settle(600);
    await shot('31-setup-sample-data');
    await sample.getByRole('button', { name: /^remove$/i }).click();
    await page.getByRole('button', { name: /remove sample data/i }).click();
    await sample.getByRole('button', { name: /load sample data/i }).waitFor({ timeout: 60_000 });
  });
  await step('dismiss the overview card, reopen it from Setup', async () => {
    await page.goto(P);
    await settle(1500);
    await page.getByRole('button', { name: /dismiss setup checklist/i }).click();
    await page.getByTestId('setup-checklist').waitFor({ state: 'detached' });
    await page.getByTestId('sidebar-setup-progress').click();
    await page.waitForURL(/\/setup/);
    await settle(1000);
    await page.getByRole('button', { name: /show checklist on overview/i }).click();
    await page.getByRole('button', { name: /hide from overview/i }).waitFor();
    await shot('32-setup-page', { fullPage: true });
  });
  await step('sidebar progress in icon mode (tooltip)', async () => {
    await page.goto(P);
    await settle(1200);
    await page.keyboard.press('Control+b');
    await page.waitForTimeout(500);
    await page.getByTestId('sidebar-setup-progress').hover();
    await page.waitForTimeout(900);
    await shot('33-sidebar-collapsed-tooltip');
    await page.keyboard.press('Control+b');
  });
  await close();
}

/* ------------------------------------------------------------------ */
/* invite: Mailpit email → second user accepts                         */
/* ------------------------------------------------------------------ */
async function invite() {
  const invitee = `setup-invitee-${RUN}@logbird.local`;
  const other = `setup-other-${RUN}@logbird.local`;
  const { context, page, settle, shot, step, close } = await session('invite-owner', { video: false, storageState: owner.state });
  const P = `${BASE}/p/${owner.projectId}`;
  let link = '';
  await step('owner invites an admin from Settings → Members', async () => {
    await page.goto(`${P}/settings/members`);
    await settle(1200);
    await page.getByPlaceholder('teammate@company.com').fill(invitee);
    await page.getByLabel('Role').selectOption('admin');
    const sentAt = Date.now() - 2000;
    await page.getByRole('button', { name: /send invite/i }).click();
    await page.getByTestId('pending-invitations').getByText(invitee).waitFor();
    await settle(600);
    await shot('40-members-pending', { fullPage: true });
    const mail = await latestMail(invitee, sentAt);
    link = /(https?:\/\/\S+\/accept-invitation\/[\w-]+)/.exec(mail.Text)?.[1] ?? '';
    if (!link) throw new Error('no accept link in the email');
    log(`     email "${mail.Subject}" → ${link}`);
    const mp = await context.newPage();
    await mp.setViewportSize({ width: 1100, height: 1000 });
    await mp.goto(`${MAILPIT}/view/${mail.ID}`);
    await mp.waitForTimeout(1500);
    await mp.screenshot({ path: path.join(OUT, '41-mailpit-invitation.png') });
    await mp.close();
  });
  await step('wrong signed-in account sees a clear warning', async () => {
    await page.goto(link);
    await page.getByTestId('invitation-wrong-email').waitFor();
    await settle(600);
    await shot('42-invitation-wrong-account');
  });

  const guest = await session('invite-accept');
  await guest.step('second user: signed-out preview → OTP → accept → name → workspace', async () => {
    const p2 = guest.page;
    await p2.goto(link);
    await guest.settle(1200);
    await guest.shot('43-invitation-signed-out');
    const sentAt = Date.now() - 2000;
    await p2.getByRole('button', { name: /email me a sign-in code/i }).click();
    const otp = p2.getByRole('textbox', { name: 'One-time code' });
    await otp.waitFor();
    const code = await latestOtp(invitee, sentAt);
    await otp.click();
    await p2.keyboard.type(code, { delay: 80 });
    await p2.getByRole('button', { name: /accept and join/i }).waitFor({ timeout: 30_000 });
    await guest.settle(800);
    await guest.shot('44-invitation-signed-in');
    await p2.getByRole('button', { name: /accept and join/i }).click();
    await p2.waitForURL(/\/onboarding\/profile/, { timeout: 30_000 });
    await guest.settle(800);
    await guest.shot('45-invitee-profile-resume');
    await p2.getByLabel('Your name').pressSequentially('Ina Vitee', { delay: 30 });
    await p2.getByRole('button', { name: /continue/i }).click();
    await p2.waitForURL(/\/p\//, { timeout: 30_000 });
    await guest.settle(1500);
    await guest.shot('46-invitee-overview');
    await p2.goto(link);
    await p2.getByTestId('invitation-accepted').waitFor();
  });
  await guest.close();

  await step('owner sees the new admin; a canceled invitation stops working', async () => {
    await page.goto(`${P}/settings/members`);
    await settle(1200);
    await page.getByTestId('members-list').getByText(invitee).waitFor();
    await page.getByPlaceholder('teammate@company.com').fill(other);
    await page.getByRole('button', { name: /send invite/i }).click();
    const row = page.getByTestId('pending-invitations').locator('li', { hasText: other });
    await row.waitFor();
    const id = await page.evaluate(
      async (email) =>
        (await (await fetch('/api/auth/organization/list-invitations')).json()).find((i) => i.email === email && i.status === 'pending')?.id,
      other,
    );
    await row.getByRole('button', { name: `Actions for ${other}` }).click();
    await page.getByRole('menuitem', { name: /cancel invitation/i }).click();
    await page.getByRole('button', { name: /^cancel invitation$/i }).click();
    await row.waitFor({ state: 'detached' });
    await settle(600);
    await shot('47-members-after', { fullPage: true });
    await page.goto(`${BASE}/accept-invitation/${id}`);
    await page.getByTestId('invitation-canceled').waitFor();
    await shot('48-invitation-canceled');
  });
  await close();
}

if (STEPS.has('onboarding')) await onboarding();
if (STEPS.has('setup') && owner.projectId) await setup();
if (STEPS.has('invite') && owner.projectId) await invite();
if (owner.projectId) console.log(`test owner: ${owner.email} (project ${owner.projectId})`);
await browser.close();
// The query bar section provokes two rejections on purpose (attempt:>abc, a SQL subquery): their 422s are expected.
const expected = (p) => /422/.test(p) && /attempt%3A%3Eabc|SELECT/.test(p);
const unexpected = problems.filter((p) => !expected(p));
console.log(
  unexpected.length ? `PROBLEMS:\n${unexpected.join('\n')}` : 'NO PROBLEMS (no console errors, no failed /api calls besides the intended 422s)',
);
