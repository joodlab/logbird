/**
 * Live proof + media for the #63 (OPS-17…22) and #65 (OWNER-08/10/11/15/16) console backlogs.
 *
 *   node scripts/console-backlogs-proof.mjs            # against the running dev stack (app :4600, server :4601)
 *
 * Creates fictional `qa-fix-backlogs-<run>-*@example.test` users (OTP via Mailpit), a "QA Fix console backlogs"
 * workspace with fictional events, captures before/after media (desktop 1440×900 + 390×844, light + dark, a flow
 * video), deletes the QA projects it created and writes proof.json. Bundled Chromium only, one browser, closed in
 * `finally`.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { signIn, watch } from './qa-shoot.mjs';

const BASE = process.env.BASE_URL ?? 'http://localhost:4600';
const SERVER = process.env.SERVER_URL ?? 'http://localhost:4601';
const OUT = path.resolve(process.env.OUT ?? '../../marketing/captures/2026-11-08-console-backlogs');
const RUN = process.env.RUN ?? Date.now().toString(36).slice(-5);
const OWNER = `qa-fix-backlogs-${RUN}-1@example.test`;
const MEMBER = `qa-fix-backlogs-${RUN}-2@example.test`;
/** A company domain nobody uses: the onboarding step pre-fills "Lantern Hotels" for it. */
const FRESH = 'owner@lantern-hotels.test';
const VARIANTS = [
  { id: 'desktop-light', width: 1440, height: 900, theme: 'light' },
  { id: 'desktop-dark', width: 1440, height: 900, theme: 'dark' },
  { id: 'phone-light', width: 390, height: 844, theme: 'light' },
  { id: 'phone-dark', width: 390, height: 844, theme: 'dark' },
];

const proof = { run: RUN, startedAt: new Date().toISOString(), owner: OWNER, member: MEMBER, checks: {}, timings: {}, problems: [] };
const check = (name, ok, detail) => {
  proof.checks[name] = { ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) };
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};

async function settle(page, ms = 900) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await page
    .waitForFunction(() => document.querySelectorAll('[data-slot=skeleton]').length === 0, undefined, { timeout: 15_000 })
    .catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function api(page, method, url, body) {
  const response = await page.request.fetch(`${BASE}${url}`, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok()) throw new Error(`${method} ${url}: ${response.status()} ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}

async function ingest(secret, events) {
  const response = await fetch(`${SERVER}/v1/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'user-agent': '@logbird/sdk/0.3.0 qa-fixture' },
    body: JSON.stringify(events),
  });
  const json = await response.json();
  if (response.status !== 202 || json.accepted !== events.length) throw new Error(`ingest ${response.status} ${JSON.stringify(json).slice(0, 300)}`);
}

function fixtureEvents() {
  const now = Date.now();
  const tenants = [
    { id: 'biz_lantern', name: 'Lantern Bay Hotel' },
    { id: 'biz_palm', name: 'Palm Court Suites' },
  ];
  const people = [
    { type: 'user', id: 'usr_qa_maya', name: 'Maya Rahman (QA)' },
    { type: 'user', id: 'usr_qa_omar', name: 'Omar Saleh (QA)' },
  ];
  const verbs = [
    ['booking.created', 'created'],
    ['booking.modified', 'changed'],
    ['rate.updated', 'updated the rate on'],
  ];
  const events = Array.from({ length: 60 }, (_, i) => {
    const tenant = tenants[i % 3 === 0 ? 1 : 0];
    const actor = people[i % 2];
    const [action, verb] = verbs[i % verbs.length];
    return {
      id: `qa-fix-evt-${RUN}-${i}`,
      action,
      occurredAt: new Date(now - (i + 1) * 55 * 60_000).toISOString(),
      outcome: i % 11 === 0 ? 'failure' : 'success',
      description: `${actor.name} ${verb} booking BK-QA-${100 + i} for ${tenant.name}`,
      actor,
      tenant,
      executor: { type: 'api', id: 'pms-api', name: 'PMS API' },
      targets: [{ type: 'booking', id: `BK-QA-${100 + i}`, name: `BK-QA-${100 + i}` }],
      context: { requestId: `req-qa-${RUN}-${i}` },
    };
  });
  const operationId = `op-qa-${RUN}`;
  const parent = {
    id: `qa-fix-parent-${RUN}`,
    action: 'booking.sync.requested',
    occurredAt: new Date(now - 40 * 60_000).toISOString(),
    outcome: 'success',
    description: 'Hourly CRM sync scheduler requested a bookings sync for Lantern Bay Hotel',
    actor: { type: 'system', id: 'sched_crm_qa', name: 'Hourly CRM sync scheduler' },
    executor: { type: 'scheduler', id: 'crm-scheduler', name: 'CRM scheduler' },
    tenant: tenants[0],
    context: { operationId },
  };
  const child = {
    id: `qa-fix-child-${RUN}`,
    action: 'booking.modified',
    occurredAt: new Date(now - 39 * 60_000).toISOString(),
    outcome: 'success',
    description: 'CRM worker confirmed BK-QA-900 for Lantern Bay Hotel',
    executor: { type: 'worker', id: 'crm-worker', name: 'CRM worker', jobId: `job-qa-${RUN}`, attempt: 1 },
    tenant: tenants[0],
    targets: [{ type: 'booking', id: 'BK-QA-900', name: 'BK-QA-900' }],
    changes: [{ field: 'status', before: 'PENDING', after: 'CONFIRMED' }],
    context: { operationId, parentEventId: parent.id },
    performed_by: 'Hourly CRM sync scheduler',
  };
  const bare = { id: `qa-fix-bare-${RUN}`, action: 'qa.bare', occurredAt: new Date(now - 30 * 60_000).toISOString() };
  return { events: [...events, parent, child, bare], parent, child, bare };
}

const browser = await chromium.launch();
const contexts = [];
const newContext = async (options) => {
  const context = await browser.newContext({ ...options, permissions: ['clipboard-read', 'clipboard-write'] });
  contexts.push(context);
  return context;
};
const created = [];
try {
  await mkdir(OUT, { recursive: true });
  const videoDir = path.join(OUT, '.video-tmp');

  // ── Owner: first run through onboarding (OWNER-15 on an @example.test address: no pre-fill, no slug line) ──
  const owner = await newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } },
  });
  const page = await owner.newPage();
  const problems = watch(page);
  await signIn(page, OWNER);
  await page.getByLabel('Your name').fill('Noor Haddad (QA)');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/onboarding\/?$/);
  await settle(page);
  const exampleName = await page.getByLabel('Workspace name').inputValue();
  check('OWNER-15 no pre-fill when the domain already has workspaces (example.test)', exampleName === '', { value: exampleName });
  check('OWNER-15 no "URL slug" line', !(await page.getByText('URL slug').count()));
  await page.screenshot({ path: path.join(OUT, 'after-owner15-workspace-step-taken-domain-desktop-light.png') });
  await page.getByLabel('Workspace name').fill('QA Fix console backlogs');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.waitForURL(/\/onboarding\/project/);
  await page.getByLabel('Project name').fill('QA Fix PMS');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/onboarding\/first-event\//);
  const pms = page.url().split('/').at(-1);
  created.push(pms);
  await page.getByTestId('skip-first-event').click();
  await page.waitForURL(new RegExp(`/p/${pms}`));
  const me = await api(page, 'GET', '/api/me');
  const organizationId = me.activeOrganizationId;

  // Fixture data (fictional) through the public ingest API.
  const loader = await api(page, 'POST', `/api/projects/${pms}/keys`, { name: 'QA fixture loader', kind: 'ingest' });
  const fixture = fixtureEvents();
  await ingest(loader.secret, fixture.events);
  const test = await api(page, 'POST', '/api/projects', { name: 'QA Fix test fixture' });
  created.push(test.project.id);
  await ingest(test.ingestKey.secret, [{ id: `qa-fix-latest-${RUN}`, action: 'fixture.ping', description: 'A single fixture event, sent last' }]);
  const reader = await api(page, 'POST', `/api/projects/${pms}/keys`, { name: 'QA Fix reporting', kind: 'read' });
  const used = await fetch(`${SERVER}/v1/events?limit=1`, { headers: { authorization: `Bearer ${reader.secret}`, 'user-agent': 'curl/8.4.0' } });
  check('read key works before the roll', used.status === 200, { status: used.status });

  // ── Member (OPS-19 landing + OPS-20 no setup nag) ──
  const invitation = await api(page, 'POST', '/api/auth/organization/invite-member', { email: MEMBER, role: 'member', organizationId });
  const memberContext = await newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const memberPage = await memberContext.newPage();
  const memberProblems = watch(memberPage);
  await signIn(memberPage, MEMBER);
  await memberPage.getByLabel('Your name').fill('Sami Odeh (QA)');
  await memberPage.getByRole('button', { name: 'Continue' }).click();
  await memberPage.waitForURL((u) => !u.pathname.startsWith('/onboarding/profile'));
  await memberPage.goto(`${BASE}/accept-invitation/${invitation.id}`);
  await memberPage.getByRole('button', { name: /Accept and join/ }).click();
  await memberPage.waitForURL(/\/p\/[^/]+$/, { timeout: 30_000 });
  await settle(memberPage);
  const landed = memberPage.url().split('/').at(-1);
  check('OPS-19 a fresh browser lands on the most active project, not the one that got the latest event', landed === pms, {
    landed,
    pms,
    latest: test.project.id,
  });
  check('OPS-20 members see no "Finish setup" in the sidebar', !(await memberPage.getByTestId('sidebar-setup-progress').count()));
  check('OPS-20 members see no setup checklist on the overview', !(await memberPage.getByTestId('setup-checklist').count()));
  await memberContext.storageState({ path: path.join(OUT, '.member-state.json') });

  // ── Owner flows (recorded) ──
  await page.goto(`${BASE}/p/${pms}`);
  await settle(page);
  check('OPS-20 owners still see the setup checklist', (await page.getByTestId('setup-checklist').count()) > 0);

  // OPS-17: one click from a tenant page.
  await page.goto(`${BASE}/p/${pms}/tenants/biz_lantern?range=7d`);
  await settle(page);
  await page.getByTestId('save-entity-view').click();
  await page.getByText('Saved “Lantern Bay Hotel — last 7 days”').waitFor();
  await page.screenshot({ path: path.join(OUT, 'after-ops17-save-from-tenant-desktop-light.png') });
  const views = await api(page, 'GET', `/api/projects/${pms}/views`);
  const view = views.data.find((v) => v.name === 'Lantern Bay Hotel — last 7 days');
  check(
    'OPS-17 one click saves the view with the hotel name',
    Boolean(view?.state.labels?.some((l) => l.label === 'Lantern Bay Hotel')),
    view?.state,
  );
  await page.goto(`${BASE}/p/${pms}/views`);
  await settle(page);
  check(
    'OPS-17 the card shows the hotel name',
    (await page.getByTestId('view-label-chips').first().innerText()).includes('Tenant: Lantern Bay Hotel'),
  );
  await page.getByTestId('copy-view-link').first().click();
  await page.getByText('Link copied').waitFor();
  const toast = await page.getByText(/Anyone in QA Fix console backlogs can open/).innerText();
  check('OPS-18 "Copy link" is a labelled button with a toast naming the workspace', Boolean(toast), toast);
  await page.screenshot({ path: path.join(OUT, 'after-ops18-copy-link-toast-desktop-light.png') });
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check('OPS-18 the copied link reopens the view', copied.includes(`view=${view.id}`), copied);
  await page.goto(copied);
  await settle(page);
  check('OPS-18 the open-view banner has "Copy link"', (await page.getByTestId('banner-copy-view-link').count()) === 1);

  // OPS-21
  await page.goto(`${BASE}/p/${pms}/events?q=${encodeURIComponent('tenant.name:"Lantern Bay')}&range=7d`);
  await settle(page);
  const problemText = await page.getByTestId('query-problem').innerText();
  check(
    'OPS-21 one plain sentence, no duplicate',
    problemText.includes('A quote mark is missing its partner — add a closing " after Lantern Bay.') && !problemText.includes('Unterminated'),
    problemText,
  );

  // OPS-22
  await page.goto(`${BASE}/p/${pms}/events?q=${encodeURIComponent(`id:${fixture.bare.id}`)}&range=7d&ev=${fixture.bare.id}`);
  await page.getByTestId('outcome-not-sent').waitFor({ timeout: 20_000 });
  check('OPS-22 a bare event says "outcome not sent", not success', true);
  await page.goto(`${BASE}/p/${pms}/events?q=${encodeURIComponent(`id:${fixture.child.id}`)}&range=7d&ev=${fixture.child.id}`);
  await page.getByTestId('missing-actor').getByText('The step that caused it').waitFor({ timeout: 20_000 });
  const hint = await page.getByTestId('missing-actor').innerText();
  check('OPS-22 a missing actor points at who the event names', hint.includes('performed_by') && hint.includes('The step that caused it'), hint);

  // OWNER-11 + OWNER-10: roll from the row, Escape never loses the uncopied secret.
  await page.goto(`${BASE}/p/${pms}/settings/keys`);
  await settle(page);
  const readerRow = page.getByTestId('api-key-row').filter({ hasText: 'QA Fix reporting' });
  check(
    'OWNER-11 the key row shows its last client before rolling',
    (await readerRow.getByTestId('key-last-used').innerText()).includes('curl/8.4.0'),
  );
  await readerRow.getByTestId('roll-key').click();
  await page.getByRole('button', { name: 'Roll key' }).click();
  await page.getByTestId('one-time-secret').waitFor();
  const newSecret = (await page.getByTestId('one-time-secret').innerText()).trim();
  await page.keyboard.press('Escape');
  await page.getByTestId('secret-close-confirm').waitFor();
  check('OWNER-10 Escape asks "Close without copying?" and keeps the secret', (await page.getByTestId('one-time-secret').count()) === 1);
  await page.screenshot({ path: path.join(OUT, 'after-owner10-escape-guard-desktop-light.png') });
  await page.getByRole('button', { name: 'Keep it open' }).click();
  await page.getByRole('button', { name: 'Copy key' }).click();
  await page.getByRole('button', { name: 'Copied' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('one-time-secret').waitFor({ state: 'detached' });
  check('OWNER-10 after copying, Escape closes normally', true);
  const oldStill = await fetch(`${SERVER}/v1/events?limit=1`, { headers: { authorization: `Bearer ${reader.secret}`, 'user-agent': 'curl/8.4.0' } });
  const fresh = await fetch(`${SERVER}/v1/events?limit=1`, {
    headers: { authorization: `Bearer ${newSecret}`, 'user-agent': 'qa-billing-export/2.1' },
  });
  check('OWNER-11 old and new keys both work during the hand-over', oldStill.status === 200 && fresh.status === 200, {
    old: oldStill.status,
    new: fresh.status,
  });
  await page.reload();
  await settle(page);
  check('OWNER-11 the old key offers "Revoke old key" and shows its last use', (await page.getByTestId('revoke-old-key').count()) === 1);
  await page.screenshot({ path: path.join(OUT, 'after-owner11-keys-after-roll-desktop-light.png'), fullPage: true });

  // OWNER-16: New project from the switcher stays in the shell and lands on Setup.
  await page
    .getByRole('button', { name: /QA Fix console backlogs/ })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'New project' }).click();
  await page.getByTestId('new-project-dialog').waitFor();
  check('OWNER-16 New project opens a dialog inside the app shell', !page.url().includes('/onboarding'));
  await page.screenshot({ path: path.join(OUT, 'after-owner16-new-project-dialog-desktop-light.png') });
  await page.getByLabel('Name', { exact: true }).fill('QA Fix empty');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/setup$/);
  const emptyId = page.url().split('/').at(-2);
  created.push(emptyId);
  await settle(page);
  check('OWNER-16 lands on the new project Setup page', page.url().endsWith(`/p/${emptyId}/setup`));
  await page.screenshot({ path: path.join(OUT, 'after-owner16-setup-after-create-desktop-light.png') });

  // OWNER-08: an empty project deletes in < 1 s; a project with data explains the wait.
  const deleteProject = async (projectId, slug, screenshot) => {
    await page.goto(`${BASE}/p/${projectId}/settings/danger`);
    await settle(page, 400);
    await page.getByRole('button', { name: 'Delete project…' }).click();
    await page.getByLabel(/to confirm/).fill(slug);
    const response = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes(`/api/projects/${projectId}`), {
      timeout: 300_000,
    });
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Delete project', exact: true }).click();
    if (screenshot) {
      await page
        .getByTestId('pending-hint')
        .waitFor({ timeout: 5000 })
        .catch(() => undefined);
      await page.screenshot({ path: path.join(OUT, screenshot) });
    }
    const r = await response;
    const ms = Date.now() - t0;
    created.splice(created.indexOf(projectId), 1);
    return { status: r.status(), ms };
  };
  const emptySlug = (await api(page, 'GET', `/api/projects/${emptyId}`)).slug;
  const emptyDelete = await deleteProject(emptyId, emptySlug);
  proof.timings.emptyProjectDeleteMs = emptyDelete.ms;
  check('OWNER-08 deleting an empty project returns in < 1 s (browser round trip)', emptyDelete.status === 204 && emptyDelete.ms < 1000, emptyDelete);
  const purge = await api(page, 'POST', '/api/projects', { name: 'QA Fix purge demo' });
  created.push(purge.project.id);
  for (let batch = 0; batch < 3; batch++)
    await ingest(
      purge.ingestKey.secret,
      Array.from({ length: 1000 }, (_, i) => ({
        id: `qa-fix-purge-${RUN}-${batch}-${i}`,
        action: 'fixture.bulk',
        tenant: { id: 'biz_lantern', name: 'Lantern Bay Hotel' },
      })),
    );
  const dataDelete = await deleteProject(purge.project.id, purge.project.slug, 'after-owner08-delete-progress-desktop-light.png');
  proof.timings.projectWithDataDeleteMs = dataDelete.ms;
  check('OWNER-08 a project with data still deletes (204) and explained the wait', dataDelete.status === 204, dataDelete);

  // ── Static pages in every variant (owner + member) ──
  await owner.storageState({ path: path.join(OUT, '.owner-state.json') });
  const ownerVideo = page.video();
  const apiPage = await owner.newPage();
  await page.close();
  await ownerVideo?.saveAs(path.join(OUT, 'flow-desktop-light.webm'));
  const pages = [
    ['ops19-projects', '/projects'],
    ['ops17-tenant-page', `/p/${pms}/tenants/biz_lantern?range=7d`],
    ['ops17-18-views', `/p/${pms}/views`],
    ['ops18-view-open-banner', new URL(copied).pathname + new URL(copied).search],
    ['ops21-query-error', `/p/${pms}/events?q=${encodeURIComponent('tenant.name:"Lantern Bay')}&range=7d`],
    ['ops22-outcome-not-sent', `/p/${pms}/events?q=${encodeURIComponent(`id:${fixture.bare.id}`)}&range=7d&ev=${fixture.bare.id}`],
    ['ops22-missing-actor-hint', `/p/${pms}/events?q=${encodeURIComponent(`id:${fixture.child.id}`)}&range=7d&ev=${fixture.child.id}`],
    ['owner11-keys', `/p/${pms}/settings/keys`],
    ['ops20-owner-overview', `/p/${pms}`],
  ];
  for (const variant of VARIANTS) {
    for (const [state, list] of [
      ['.owner-state.json', pages],
      ['.member-state.json', [['ops20-member-overview', `/p/${pms}`]]],
    ]) {
      const context = await newContext({
        viewport: { width: variant.width, height: variant.height },
        colorScheme: variant.theme,
        deviceScaleFactor: variant.width < 600 ? 2 : 1,
        storageState: path.join(OUT, state),
      });
      const shot = await context.newPage();
      const shotProblems = watch(shot, () => `${variant.id} ${shot.url().replace(BASE, '')}`);
      for (const [name, url] of list) {
        await shot.goto(`${BASE}${url}`);
        await settle(shot);
        if (name.startsWith('ops22'))
          await shot
            .locator('[data-slot="sheet-content"]')
            .waitFor({ timeout: 15_000 })
            .catch(() => undefined);
        await shot.screenshot({ path: path.join(OUT, `after-${name}-${variant.id}.png`) });
      }
      proof.problems.push(...shotProblems);
      await context.close();
      contexts.splice(contexts.indexOf(context), 1);
    }
  }

  // ── Phone (390, dark): the secret guard and the in-shell New project dialog ──
  const phone = await newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
    deviceScaleFactor: 2,
    storageState: path.join(OUT, '.owner-state.json'),
    recordVideo: { dir: videoDir, size: { width: 390, height: 844 } },
  });
  const phonePage = await phone.newPage();
  const phoneProblems = watch(phonePage);
  await phonePage.goto(`${BASE}/p/${pms}/settings/keys`);
  await settle(phonePage);
  await phonePage.getByRole('button', { name: 'Create key' }).click();
  await phonePage.getByLabel('Name', { exact: true }).fill('QA Fix phone check');
  await phonePage.getByRole('button', { name: 'Create key' }).last().click();
  await phonePage.getByTestId('one-time-secret').waitFor();
  await phonePage.keyboard.press('Escape');
  await phonePage.getByTestId('secret-close-confirm').waitFor();
  await phonePage.screenshot({ path: path.join(OUT, 'after-owner10-escape-guard-phone-dark.png') });
  await phonePage.getByRole('button', { name: 'Close anyway' }).click();
  await phonePage.goto(`${BASE}/projects`);
  await settle(phonePage);
  await phonePage.getByRole('button', { name: 'New project' }).click();
  await phonePage.getByTestId('new-project-dialog').waitFor();
  await phonePage.screenshot({ path: path.join(OUT, 'after-owner16-new-project-dialog-phone-dark.png') });
  await phonePage.keyboard.press('Escape');
  await phonePage.waitForTimeout(600);
  proof.problems.push(...phoneProblems);
  const phoneVideo = phonePage.video();
  await phonePage.close();
  await phoneVideo?.saveAs(path.join(OUT, 'flow-phone-dark.webm'));

  // ── OWNER-15 on an unused company domain: pre-filled and selected ──
  const freshContext = await newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const freshPage = await freshContext.newPage();
  await signIn(freshPage, FRESH);
  await freshPage.waitForURL((u) => u.pathname.startsWith('/onboarding'), { timeout: 30_000 });
  if (freshPage.url().includes('/onboarding/profile')) {
    await freshPage.getByLabel('Your name').fill('Lina Haddad (QA)');
    await freshPage.getByRole('button', { name: 'Continue' }).click();
  }
  await freshPage.waitForURL((u) => u.pathname === '/onboarding' || u.pathname === '/onboarding/');
  await freshPage.getByLabel('Workspace name').waitFor();
  await freshPage
    .waitForFunction(() => document.querySelector('#workspace-name')?.value === 'Lantern Hotels', undefined, { timeout: 10_000 })
    .catch(() => undefined);
  const prefilled = await freshPage.getByLabel('Workspace name').inputValue();
  const selected = await freshPage.evaluate(() => {
    const input = document.querySelector('#workspace-name');
    return input ? input.selectionEnd - input.selectionStart : 0;
  });
  check('OWNER-15 an unused company domain is pre-filled and selected', prefilled === 'Lantern Hotels' && selected === prefilled.length, {
    prefilled,
    selected,
  });
  await freshPage.screenshot({ path: path.join(OUT, 'after-owner15-workspace-step-new-domain-desktop-dark.png') });

  // ── Cleanup: the QA projects this run created (workspace + fictional users stay, like earlier audits). ──
  for (const projectId of [...created]) {
    const project = await api(apiPage, 'GET', `/api/projects/${projectId}`);
    await api(apiPage, 'DELETE', `/api/projects/${projectId}?confirm=${encodeURIComponent(project.slug)}`);
    created.splice(created.indexOf(projectId), 1);
  }
  check('cleanup: QA projects deleted', created.length === 0);
  proof.problems.push(...problems, ...memberProblems);
} finally {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser.close();
}
proof.problems = [...new Set(proof.problems)];
proof.finishedAt = new Date().toISOString();
await writeFile(path.join(OUT, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
// Recordings were saved explicitly above; drop Playwright's temporary copies.
await rm(path.join(OUT, '.video-tmp'), { recursive: true, force: true });
await rm(path.join(OUT, '.owner-state.json'), { force: true });
await rm(path.join(OUT, '.member-state.json'), { force: true });
console.log(proof.problems.length ? `Problems:\n${proof.problems.join('\n')}` : 'No console warnings/errors.');
const failed = Object.entries(proof.checks).filter(([, v]) => !v.ok);
if (failed.length) {
  console.error(`FAILED: ${failed.map(([k]) => k).join('; ')}`);
  process.exitCode = 1;
}
