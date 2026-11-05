// Recorded end-to-end walkthrough against the real local stack (`pnpm dev`, demo data): OTP sign-in via Mailpit → overview →
// explorer query → event detail → operation → impersonation search → actor/tenant profiles → retention preview → API keys →
// dark mode → Ledger project, then the query bar v2 flows (Query/SQL modes, autocomplete, inline errors, SQL saved view).
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
const owner = { email: `setup-owner-${RUN}@trailmark.local`, state: path.join(OUT, `.state-owner-${RUN}.json`), projectId: '' };

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
    if (!secret.startsWith('tm_ingest_')) throw new Error('no secret revealed');
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
  const invitee = `setup-invitee-${RUN}@trailmark.local`;
  const other = `setup-other-${RUN}@trailmark.local`;
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
