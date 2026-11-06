/**
 * Evidence for the console against the REAL stack (server + worker + app, `pnpm dev` at the repo root).
 *
 *   node scripts/capture-media.mjs [flows…]       # default: every flow
 *   flows: shots phone signin onboarding explorer follow settings
 *
 * Sign-in codes come from Mailpit's API. Videos are recorded per flow at 1280×800 (webm, a few MB each) and
 * screenshots go to marketing/captures/2026-11-04-ui-real-api/. `onboarding` creates a fresh user + workspace + project, sends the
 * copied curl snippet with bash, then streams back-dated events (Arabic and very long names included) so the
 * retention flow has something to preview. Every console warning/error and failed /api call is reported.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { signIn, watch } from './qa-shoot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../../marketing/captures/2026-11-04-ui-real-api');
const TMP = path.join(OUT, '.video-tmp');
const BASE = process.env.BASE_URL ?? 'http://localhost:4600';
const DEMO = process.env.DEMO_EMAIL ?? 'demo@logbird.local';
const VIDEO = { width: 1280, height: 800 };
const flows = process.argv.slice(2);
const want = (name) => flows.length === 0 || flows.includes(name);
const problems = [];

const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

async function api(page, pathname, init) {
  return page.evaluate(
    async ([p, i]) => {
      const r = await fetch(p, { credentials: 'same-origin', ...i, headers: { 'content-type': 'application/json', ...(i?.headers ?? {}) } });
      return r.status === 204 ? null : r.json();
    },
    [pathname, init],
  );
}

async function settle(page, ms = 900) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  await page
    .waitForFunction(() => document.querySelectorAll('[data-slot=skeleton]').length === 0, undefined, { timeout: 20_000 })
    .catch(() => undefined);
  await page.waitForTimeout(ms);
}

/** A context whose video is saved as <name>.webm when `done()` is called. */
async function recorded(name, options = {}) {
  const dir = path.join(TMP, name);
  await rm(dir, { recursive: true, force: true });
  const context = await browser.newContext({ viewport: VIDEO, recordVideo: { dir, size: VIDEO }, ...options });
  const page = await context.newPage();
  const seen = watch(page, () => `${name} ${page.url().replace(BASE, '')}`);
  return {
    context,
    page,
    async done() {
      await page.waitForTimeout(800);
      await context.close();
      const [file] = await readdir(dir);
      if (file) await rename(path.join(dir, file), path.join(OUT, `${name}.webm`));
      problems.push(...seen);
      console.log(`🎬 ${name}.webm`);
    },
  };
}

async function demoState() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page, DEMO);
  await settle(page);
  const state = await context.storageState();
  const projects = (await api(page, '/api/projects')).data;
  await context.close();
  return { state, projects };
}

/** STEPS=<dir>: also save a still at each step of the recorded flows, for reviewing them frame by frame. */
let step = 0;
async function snap(page, label) {
  if (!process.env.STEPS) return;
  await mkdir(process.env.STEPS, { recursive: true });
  step += 1;
  await page.screenshot({ path: path.join(process.env.STEPS, `${String(step).padStart(2, '0')}-${label}.png`) });
}

/** Slowly type like a person so the video reads well. */
async function type(page, text, delay = 55) {
  await page.keyboard.type(text, { delay });
}

const { state, projects } = await demoState();
const acme = projects.find((p) => p.slug === 'staydesk') ?? projects[0];
const ledger = projects.find((p) => p.slug === 'ledger-demo') ?? projects[1];
const J = `/p/${acme.id}`;
console.log(`signed in as ${DEMO}; StayDesk=${acme.id} Ledger=${ledger?.id}`);

/* ------------------------------------------------------------------ */
/* Screenshots: every page, light + dark, against the demo data        */
/* ------------------------------------------------------------------ */
/** A recent failure that belongs to an operation, with an actor, tenant and target to follow. */
async function entityIds(page) {
  const { data } = await api(page, `/api/projects/${acme.id}/events?q=${encodeURIComponent('outcome:failure')}&limit=50`);
  const event = data.find((e) => e.context.operationId && e.actor && e.tenant && e.targets.length) ?? data[0];
  return { event };
}

const PAGES = (ids) => [
  [`${J}`, 'overview'],
  [`${J}/events`, 'explorer'],
  [`${J}/events?q=${encodeURIComponent('outcome:failure')}&ev=${encodeURIComponent(ids.event.id)}`, 'event-sheet'],
  [`${J}/operations/${encodeURIComponent(ids.event.context.operationId)}`, 'operation'],
  [`${J}/actors`, 'actors'],
  [`${J}/actors/${encodeURIComponent(ids.event.actor?.id ?? 'usr_1')}`, 'actor'],
  [`${J}/tenants`, 'tenants'],
  [`${J}/tenants/${encodeURIComponent(ids.event.tenant?.id ?? 'biz_1')}`, 'tenant'],
  [`${J}/workers`, 'workers'],
  [`${J}/workers/business-crm-worker`, 'worker'],
  [`${J}/records`, 'records'],
  [`${J}/records/${encodeURIComponent(`${ids.event.targets[0]?.type}:${ids.event.targets[0]?.id}`)}`, 'record'],
  [`${J}/views`, 'views'],
  [`${J}/fields`, 'fields'],
  [`${J}/docs`, 'quickstart'],
  [`${J}/settings`, 'settings-general'],
  [`${J}/settings/retention`, 'settings-retention'],
  [`${J}/settings/keys`, 'settings-keys'],
  [`${J}/settings/members`, 'settings-members'],
  [`${J}/settings/activity`, 'settings-activity'],
  [`${J}/settings/danger`, 'settings-danger'],
  ['/projects', 'projects'],
  ...(ledger
    ? [
        [`/p/${ledger.id}`, 'ledger-overview'],
        [`/p/${ledger.id}/events?range=7d`, 'ledger-explorer'],
      ]
    : []),
];

if (want('shots')) {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, storageState: state });
    const page = await context.newPage();
    problems.push(...watch(page, () => `${theme} ${page.url().replace(BASE, '')}`));
    await page.goto(`${BASE}/projects`);
    const ids = await entityIds(page);
    for (const [url, name] of PAGES(ids)) {
      await page.goto(`${BASE}${url}`);
      await settle(page);
      await page.screenshot({ path: path.join(OUT, `${theme}-${name}.png`) });
    }
    // Interaction states worth a still: autocomplete and the retention confirm.
    await page.goto(`${BASE}${J}/events`);
    await settle(page);
    await page.getByRole('combobox', { name: 'Query' }).click();
    await type(page, 'tenant.name:', 0);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, `${theme}-explorer-autocomplete.png`) });
    await page.goto(`${BASE}${J}/settings/retention`);
    await settle(page);
    await page
      .getByRole('radio', { name: /^30 days/ })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, `${theme}-settings-retention-preview.png`) });
    await context.close();
    console.log(`📸 ${theme}: ${PAGES(ids).length + 2} pages`);
  }
}

if (want('phone')) {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      colorScheme: theme,
      storageState: state,
    });
    const page = await context.newPage();
    problems.push(...watch(page, () => `phone ${page.url().replace(BASE, '')}`));
    await page.goto(`${BASE}/projects`);
    const ids = await entityIds(page);
    const names = ['overview', 'explorer', 'event-sheet', 'operation', 'actor', 'settings-retention', 'settings-keys', 'quickstart'];
    for (const [url, name] of PAGES(ids).filter(([, n]) => names.includes(n))) {
      await page.goto(`${BASE}${url}`);
      await settle(page);
      await page.screenshot({ path: path.join(OUT, `phone-${theme}-${name}.png`) });
    }
    await context.close();
    console.log(`📱 phone ${theme}`);
  }
}

/* ------------------------------------------------------------------ */
/* Video 1: OTP sign-in → overview → switch project                    */
/* ------------------------------------------------------------------ */
if (want('signin')) {
  const { page, done } = await recorded('signin-overview');
  await page.goto(`${BASE}/login`);
  await page.waitForTimeout(600);
  await page.getByLabel('Work email').click();
  await type(page, DEMO);
  const sentAt = Date.now() - 2000;
  await page.getByRole('button', { name: /continue with email/i }).click();
  const otp = page.getByRole('textbox', { name: 'One-time code' });
  await otp.waitFor();
  const { latestOtp } = await import('./qa-shoot.mjs');
  const code = await latestOtp(DEMO, sentAt);
  await page.waitForTimeout(700);
  await otp.click();
  await type(page, code, 120);
  await page.waitForURL((u) => u.pathname.startsWith('/p/'), { timeout: 30_000 });
  await settle(page, 1500);
  await snap(page, 'step');
  await page.mouse.move(700, 450, { steps: 12 });
  await page.waitForTimeout(1200);
  if (ledger) {
    await page
      .getByRole('button', { name: /select a project|staydesk|ledger demo/i })
      .first()
      .click();
    await page.waitForTimeout(700);
    await page.getByRole('menuitem', { name: ledger.name }).click();
    await settle(page, 1800);
    await snap(page, 'step');
    await page.getByRole('link', { name: 'Explorer' }).first().click();
    await settle(page, 1800);
    await snap(page, 'step');
  }
  await done();
}

/* ------------------------------------------------------------------ */
/* Video 2: onboarding a brand-new workspace → first event             */
/* ------------------------------------------------------------------ */
let onboarded;
if (want('onboarding')) {
  const email = `newcomer-${Date.now().toString(36)}@logbird.local`;
  const { page, context, done } = await recorded('onboarding-first-event', { permissions: ['clipboard-read', 'clipboard-write'] });
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Work email').click();
  await type(page, email, 35);
  const sentAt = Date.now() - 2000;
  await page.getByRole('button', { name: /continue with email/i }).click();
  const otp = page.getByRole('textbox', { name: 'One-time code' });
  await otp.waitFor();
  const { latestOtp } = await import('./qa-shoot.mjs');
  const code = await latestOtp(email, sentAt);
  await otp.click();
  await type(page, code, 100);
  await page.waitForURL((u) => u.pathname.startsWith('/onboarding/profile'), { timeout: 30_000 });
  await settle(page, 800);
  await snap(page, 'step');
  // OTP sign-up has no name yet: the first step asks for one.
  await page.getByLabel('Your name').click();
  await type(page, 'Nour Al-Huda');
  await page.screenshot({ path: path.join(OUT, 'light-onboarding-name.png') });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL((u) => u.pathname === '/onboarding' || u.pathname === '/onboarding/', { timeout: 20_000 });
  await settle(page, 800);
  await snap(page, 'step');
  await page.getByLabel('Workspace name').fill('');
  await type(page, 'Nour Al-Huda Hospitality · نور الهدى');
  await page.screenshot({ path: path.join(OUT, 'light-onboarding-workspace.png') });
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.waitForURL((u) => u.pathname.startsWith('/onboarding/project'), { timeout: 20_000 });
  await settle(page, 700);
  await snap(page, 'step');
  await page.getByLabel('Project name').fill('');
  await type(page, 'Guest portal');
  await page
    .getByRole('radio', { name: /^90 days/ })
    .first()
    .click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'light-onboarding-project.png') });
  await page.getByRole('button', { name: /create project/i }).click();
  await page.waitForURL((u) => u.pathname.startsWith('/onboarding/first-event'), { timeout: 20_000 });
  await settle(page, 1200);
  await snap(page, 'step');
  const projectId = page.url().split('/').at(-1);
  await page.screenshot({ path: path.join(OUT, 'light-onboarding-first-event-waiting.png') });
  // Copy the curl snippet exactly as a person would, then run it with bash.
  await page.getByRole('tab', { name: 'curl' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Copy snippet' }).click();
  const snippet = await page.evaluate(() => navigator.clipboard.readText());
  await writeFile(path.join(OUT, '.copied-curl.sh'), snippet);
  const result = execFileSync('bash', [path.join(OUT, '.copied-curl.sh')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  console.log(`   copied curl → ${result.trim()}`);
  await rm(path.join(OUT, '.copied-curl.sh'));
  await page.getByText('First event received').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(OUT, 'light-onboarding-first-event-received.png') });
  const key = /Bearer (lb_ingest_\w+)/.exec(snippet)?.[1];
  await page.getByText('Open overview').click();
  await settle(page, 2500);
  await snap(page, 'step');
  onboarded = { projectId, key, email, state: await context.storageState() };
  await done();
}

/* Back-dated events with Arabic and very long names, sent through the public API with the new key. */
if (onboarded?.key) {
  const people = [
    ['usr_ar_1', 'نورة الحربي', 'noura@nour-alhuda.example'],
    ['usr_ar_2', 'عبدالرحمن بن عبدالعزيز آل سعود الشمري', 'abdulrahman@nour-alhuda.example'],
    ['usr_en_1', 'Maximilian Alexander von Hohenberg-Wittelsbach III (Revenue Operations)', 'max@nour-alhuda.example'],
    ['usr_en_2', 'Lina Haddad', 'lina@nour-alhuda.example'],
  ];
  const tenants = [
    ['biz_nh', 'فنادق نور الهدى'],
    ['biz_long', 'The Extraordinarily Long-Named Boutique Hotel & Residences Collection of the Arabian Gulf Coast'],
  ];
  const actions = ['booking.created', 'booking.modified', 'hotel.policy.updated', 'guest.updated', 'payment.refunded', 'room.rate.changed'];
  const events = [];
  for (let i = 0; i < 240; i++) {
    const [id, name, email] = people[i % people.length];
    const [tid, tname] = tenants[i % tenants.length];
    const action = actions[i % actions.length];
    const fail = i % 17 === 0;
    events.push({
      action,
      occurredAt: new Date(Date.now() - (i / 240) * 80 * 864e5 - 60_000).toISOString(),
      outcome: fail ? 'failure' : i % 23 === 0 ? 'denied' : 'success',
      severity: fail ? 'warning' : 'info',
      description: `${name} ${action.split('.').at(-1)} ${action.split('.')[0]} for ${tname}`,
      actor: { type: 'user', id, name, email },
      ...(i % 29 === 0 ? { impersonator: { id: 'usr_support', name: 'دعم العملاء — Customer support' } } : {}),
      executor: { type: i % 3 ? 'api' : 'worker', id: i % 3 ? 'api-server' : 'booking-worker', name: i % 3 ? 'API server' : 'عامل الحجوزات' },
      tenant: { id: tid, name: tname },
      targets: [{ type: 'booking', id: `bk_${1000 + i}`, name: `حجز رقم ${1000 + i}` }],
      changes: [{ field: 'status', before: 'pending', after: fail ? 'failed' : 'confirmed' }],
      context: { operationId: `op_nh_${Math.floor(i / 3)}`, requestId: `req_nh_${i}` },
      metadata: { channel: i % 2 ? 'web' : 'whatsapp' },
    });
  }
  const res = await fetch(`${BASE}/v1/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${onboarded.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  });
  console.log(`   back-dated ${events.length} events → ${res.status} ${JSON.stringify(await res.json()).slice(0, 80)}`);
  await new Promise((r) => setTimeout(r, 2500));
  // Stills of the new project: names in Arabic and very long names.
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, storageState: onboarded.state });
    const page = await context.newPage();
    problems.push(...watch(page, () => `onboarded ${page.url().replace(BASE, '')}`));
    const P = `/p/${onboarded.projectId}`;
    for (const [url, name] of [
      [`${P}?range=90d`, 'arabic-overview'],
      [`${P}/events?range=90d`, 'arabic-explorer'],
      [`${P}/actors`, 'arabic-actors'],
      [`${P}/actors/usr_ar_2?range=90d`, 'arabic-actor'],
    ]) {
      await page.goto(`${BASE}${url}`);
      await settle(page);
      await snap(page, 'step');
      await page.screenshot({ path: path.join(OUT, `${theme}-${name}.png`) });
    }
    await context.close();
  }
}

/* ------------------------------------------------------------------ */
/* Video 3: explorer — autocomplete, facets, zoom, detail, operation   */
/* ------------------------------------------------------------------ */
if (want('explorer')) {
  const { page, done } = await recorded('explorer-search-filter-zoom-detail', { storageState: state });
  await page.goto(`${BASE}${J}/events`);
  await settle(page, 1200);
  await snap(page, 'step');
  await page.keyboard.press('/');
  await type(page, 'tenant.na');
  await page.waitForTimeout(700);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(1200);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await type(page, '(outcome:failure OR outcome:denied)');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await settle(page, 1500);
  await snap(page, 'step');
  // Facet: exclude one action with ⌥-click.
  const facetRow = page.locator('aside[aria-label=Filters] section').filter({ hasText: 'Action' }).locator('button[aria-pressed]').first();
  await facetRow.click({ modifiers: ['Alt'] });
  await settle(page, 1500);
  await snap(page, 'step');
  // Drag across the histogram to zoom.
  const chart = page.locator('.recharts-wrapper').first();
  const box = await chart.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5, { steps: 18 });
    await page.mouse.up();
  }
  await settle(page, 1500);
  await snap(page, 'step');
  await page.locator('[role=row][data-index="0"]').click();
  await settle(page, 1200);
  await snap(page, 'step');
  await page.keyboard.press('j');
  await page.waitForTimeout(900);
  await page.keyboard.press('j');
  await page.waitForTimeout(900);
  await page.keyboard.press('k');
  await page.waitForTimeout(900);
  await page
    .getByRole('dialog')
    .getByText(/raw json/i)
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => undefined);
  await page.waitForTimeout(1200);
  const op = page.getByRole('button', { name: /view operation/i });
  if (await op.isVisible().catch(() => false)) {
    await op.click();
    await settle(page, 2500);
    await snap(page, 'step');
  }
  await done();
}

/* ------------------------------------------------------------------ */
/* Video 4: follow an actor → tenant → record                          */
/* ------------------------------------------------------------------ */
if (want('follow')) {
  const { page, done } = await recorded('follow-actor-tenant-record', { storageState: state });
  await page.goto(`${BASE}${J}/actors?type=user`);
  await settle(page, 1200);
  await snap(page, 'step');
  await page.getByRole('link').filter({ hasText: /Al-/ }).first().click();
  await settle(page, 1800);
  await snap(page, 'step');
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(900);
  await page.locator('a[href*="/tenants/"]').first().click();
  await settle(page, 1800);
  await snap(page, 'step');
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(900);
  await page.locator('a[href*="/records/"]').first().click();
  await settle(page, 1800);
  await snap(page, 'step');
  await page.goBack();
  await settle(page, 1200);
  await snap(page, 'step');
  await page.goForward();
  await settle(page, 1500);
  await snap(page, 'step');
  await done();
}

/* ------------------------------------------------------------------ */
/* Video 5: retention lowering (preview + slug confirm) + API keys     */
/* ------------------------------------------------------------------ */
if (want('settings') && onboarded) {
  const { page, done } = await recorded('retention-and-api-keys', { storageState: onboarded.state });
  const P = `/p/${onboarded.projectId}`;
  await page.goto(`${BASE}${P}/settings/retention`);
  await settle(page, 1200);
  await snap(page, 'step');
  await page
    .getByRole('radio', { name: /^30 days/ })
    .first()
    .click();
  await page.getByText(/That is [\d,]+ events?/).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /lower retention/i }).click();
  await page.waitForTimeout(800);
  await page.getByLabel(/to confirm/).click();
  const slug = await page.getByLabel(/to confirm/).getAttribute('placeholder');
  await type(page, slug ?? '', 70);
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /delete and lower/i }).click();
  await page.getByText(/Retention set to 30 days/).waitFor({ timeout: 30_000 });
  await settle(page, 2000);
  await snap(page, 'step');
  await page.getByRole('link', { name: 'API keys' }).click();
  await settle(page, 1000);
  await snap(page, 'step');
  await page
    .getByRole('button', { name: /create key/i })
    .first()
    .click();
  await page.waitForTimeout(500);
  await page.getByLabel('Name').fill('');
  await type(page, 'Partner portal (read)');
  await page.getByRole('radio', { name: /^Read/ }).click();
  await page.waitForTimeout(400);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /create key/i })
    .click();
  await page.getByText(/only time Logbird shows/).waitFor();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: /i have stored the key/i }).click();
  await settle(page, 900);
  await snap(page, 'step');
  await page.getByRole('button', { name: 'Revoke' }).first().click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: 'Revoke key' }).click();
  await settle(page, 1800);
  await snap(page, 'step');
  await done();
}

await browser.close();
await rm(TMP, { recursive: true, force: true });
const unique = [...new Set(problems)];
console.log(unique.length ? `\nProblems:\n${unique.join('\n')}` : '\nNo console warnings/errors and no failed /api requests.');
if (unique.length) process.exitCode = 1;
