/**
 * Support-impersonation proof (PR #69 round 2) against a REAL local stack (app :4600, server :4601, worker).
 *
 *   AXE=/path/to/axe.min.js OUT=../../marketing/captures/2026-11-07-impersonation-visible node scripts/support-proof.mjs
 *
 * Creates a fictional user/workspace/project (qa-fix-support-*@example.test, "QA Fix support"), ingests 10,000 ordinary
 * events plus support events from 22 fictional agents (one with a very long name, one in Arabic), some with no actor or
 * tenant, and job retries. Checks:
 *  - counts: "Any support agent" = every support event (22 agents > the 20 listed); the agent page never counts the
 *    missing actor/tenant as a customer/tenant;
 *  - facet semantics in the UI: hide support, then pick an agent → only that agent (no contradictory query);
 *  - keyboard on #70's grid: the support links in rows are not tab stops; the row's name says who was at the keyboard;
 *    Enter on a row opens the sheet; Enter on a support link opens only the agent page (Back has no `ev`);
 *    Ctrl+End lands on exactly the last loaded row of a 10k-event result;
 *  - round 3: a user OR on the agent page returns only that agent's events; the agent page opens on 7 days; a failed
 *    summary query shows the page banner and "Couldn't load" in its panel, and Retry recovers every failed panel; the
 *    unknown-agent page shows only its empty state; Ctrl K says when the agent lookup failed; at 390px the support pill
 *    and the action name never overlap;
 *  - axe violations outside the known master baseline (the query textarea's role, the command palette button's label)
 *    fail the run.
 *  - 390px with long names: no horizontal page scroll, markers stay inside their row (light and dark);
 *  - axe-core (wcag2a/aa, wcag21a/aa, wcag22aa, best-practice) on the changed screens, light and dark.
 * The QA project is deleted at the end. One browser, closed in `finally`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { signIn, watch } from './qa-shoot.mjs';

const BASE = process.env.BASE_URL ?? 'http://localhost:4600';
const SERVER = process.env.SERVER_URL ?? 'http://127.0.0.1:4601';
const OUT = path.resolve(process.env.OUT ?? '.');
const AXE = await readFile(process.env.AXE ?? 'axe.min.js', 'utf8');
const EMAIL = `qa-fix-support-${Date.now().toString(36)}@example.test`;
const H = { Origin: BASE };

const log = [];
const results = {};
function note(key, value) {
  results[key] = value;
  const line = `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
  log.push(line);
  console.log(line);
}
function check(name, ok, detail) {
  note(`${ok ? 'PASS' : 'FAIL'} ${name}`, detail ?? '');
  if (!ok) results.failed = (results.failed ?? 0) + 1;
}

/* ---------------- fixture ---------------- */
const LONG_AGENT = 'Maximilian Bartholomew Featherstonehaugh-Montgomery (fictional QA support)';
const RTL_AGENT = 'ليلى الحسيني (وكيلة دعم وهمية)';
const LONG_CUSTOMER = { id: 'usr_long', type: 'user', name: 'Anastasia Konstantinopoulou-Vanderbilt (fictional customer)' };
const agentName = (a) => (a === 0 ? LONG_AGENT : a === 1 ? RTL_AGENT : `QA Agent ${String(a).padStart(2, '0')} (fictional)`);
const agentId = (a) => `qa_support_${String(a).padStart(2, '0')}`;
const AGENTS = 22;

function fixtureEvents() {
  const now = Date.now();
  const out = [];
  // Newest first: support events at the top of the list.
  for (let a = 0; a < AGENTS; a++)
    for (let i = 0; i < 2; i++)
      out.push({
        action: 'booking.modified',
        occurredAt: new Date(now - (a * 2 + i) * 1000).toISOString(),
        actor: a % 2 ? { id: 'usr_1', type: 'user', name: 'Omar Fictional' } : LONG_CUSTOMER,
        impersonator: { id: agentId(a), name: agentName(a) },
        tenant: { id: 'tn_qa_0', name: 'QA Tenant 0' },
        targets: [{ type: 'booking', id: `bk-s-${a}-${i}`, name: `BK-S-${a}-${i}` }],
        description: `Booking BK-S-${a}-${i} changed`,
      });
  // Support events without an actor or tenant: they are not a customer or a tenant.
  for (let i = 0; i < 3; i++)
    out.push({
      action: 'booking.viewed',
      occurredAt: new Date(now - (60 + i) * 1000).toISOString(),
      impersonator: { id: agentId(0), name: LONG_AGENT },
    });
  // Job retries.
  for (let i = 0; i < 4; i++)
    out.push({
      action: 'invoice.sync',
      occurredAt: new Date(now - (70 + i) * 1000).toISOString(),
      executor: { type: 'worker', id: 'billing-worker', name: 'Billing worker', jobId: `job_qa_${i}`, attempt: i + 1 },
      tenant: { id: 'tn_qa_1', name: 'QA Tenant 1' },
    });
  for (let i = 0; i < 10_000; i++)
    out.push({
      action: i % 3 ? 'booking.modified' : 'page.viewed',
      occurredAt: new Date(now - 120_000 - i * 200).toISOString(),
      actor: { id: `usr_${i % 4}`, type: 'user', name: ['Vera Validator', 'Omar Fictional', 'Lina Placeholder', 'Tariq Example'][i % 4] },
      tenant: { id: `tn_qa_${i % 2}`, name: `QA Tenant ${i % 2}` },
      outcome: i % 7 ? 'success' : 'failure',
    });
  return out;
}
const SUPPORT_EVENTS = AGENTS * 2 + 3;

async function settle(page, ms = 800) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await page
    .waitForFunction(() => document.querySelectorAll('[data-slot=skeleton]').length === 0, undefined, { timeout: 15_000 })
    .catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function axe(page, name, include) {
  await page.addScriptTag({ content: AXE });
  const res = await page.evaluate(
    async ({ include }) =>
      window.axe.run(include ? { include: [include] } : document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        rules: { region: { enabled: false } },
      }),
    { include },
  );
  const violations = res.violations.map((v) => ({
    id: v.id,
    nodes: v.nodes.length,
    sample: v.nodes.slice(0, 2).map((n) => n.target.join(' ')),
    // Known on master, on every page: the query bar's textarea role and the top-bar command palette button's label.
    baseline: v.nodes.every(
      (n) =>
        (v.id === 'aria-allowed-role' && /^<textarea/.test(n.html)) ||
        (v.id === 'label-content-name-mismatch' && n.html.includes('aria-label="Open command palette"')),
    ),
  }));
  results.axe = results.axe ?? {};
  results.axe[name] = violations;
  const fresh = violations.filter((v) => !v.baseline);
  check(
    `axe ${name}: nothing outside the master baseline`,
    fresh.length === 0,
    violations.length ? violations.map((v) => `${v.id}(${v.nodes})${v.baseline ? ' [baseline]' : ` ${v.sample.join(' | ')}`}`).join(', ') : '0',
  );
}

const focused = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    const row = el?.closest?.('[role="row"]');
    return {
      tag: el?.tagName ?? null,
      role: el?.getAttribute?.('role') ?? null,
      inGrid: Boolean(el?.closest?.('[role="grid"]')),
      index: row ? Number(row.getAttribute('data-index')) : null,
      label: (el?.getAttribute?.('aria-label') ?? '').slice(0, 160),
    };
  });

/** Tab until a grid row has focus, taking the "Skip filters to events" link past the facets. */
async function enterGrid(page, max = 60) {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press('Tab');
    const f = await focused(page);
    if (f.role === 'row') return i;
    if (
      /Skip filters to events/.test(f.label) ||
      /Skip filters to events/.test(await page.evaluate(() => document.activeElement?.textContent ?? ''))
    ) {
      await page.keyboard.press('Enter');
      return i + 1;
    }
  }
  return -1;
}

const browser = await chromium.launch();
let projectId;
let projectSlug;
let api;
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  const problems = watch(page);
  api = ctx.request;
  await signIn(page, EMAIL);
  const json = async (res) => {
    if (!res.ok()) throw new Error(`${res.url()} → ${res.status()} ${await res.text()}`);
    return res.status() === 204 ? null : res.json();
  };
  await json(await api.post(`${BASE}/api/auth/update-user`, { headers: H, data: { name: 'Robin Fixture' } }));
  const org = await json(
    await api.post(`${BASE}/api/auth/organization/create`, {
      headers: H,
      data: { name: 'QA Fix support', slug: `qa-fix-support-${Date.now().toString(36)}` },
    }),
  );
  await json(await api.post(`${BASE}/api/auth/organization/set-active`, { headers: H, data: { organizationId: org.id } }));
  const created = await json(await api.post(`${BASE}/api/projects`, { headers: H, data: { name: 'QA support r2' } }));
  projectId = created.project.id;
  projectSlug = created.project.slug;
  await json(await api.patch(`${BASE}/api/projects/${projectId}`, { headers: H, data: { retentionReviewed: true } }));
  const all = fixtureEvents();
  for (let i = 0; i < all.length; i += 500) {
    const res = await fetch(`${SERVER}/v1/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.ingestKey.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(all.slice(i, i + 500)),
    });
    if (res.status !== 202) throw new Error(`ingest ${res.status} ${await res.text()}`);
  }
  const from = new Date(Date.now() - 3_600_000).toISOString();
  let total = 0;
  for (let i = 0; i < 90 && total < Math.min(all.length, 10_001); i++) {
    total = (await json(await api.get(`${BASE}/api/projects/${projectId}/events?from=${from}&limit=1`, { headers: H }))).total ?? 0;
    if (total < Math.min(all.length, 10_001)) await page.waitForTimeout(1000);
  }
  // The search total is capped at 10,001 ("10,000+").
  check('fixture ingested (10k+ rows)', total >= Math.min(all.length, 10_001), total);
  const P = (p, q) => `${BASE}/p/${projectId}${p}?range=1h${q ? `&q=${encodeURIComponent(q)}` : ''}`;

  /* ---------------- counts (API, as the UI asks) ---------------- */
  const facet = async (field, q, limit) =>
    json(
      await api.get(`${BASE}/api/projects/${projectId}/facets?field=${field}&from=${from}&q=${encodeURIComponent(q)}&limit=${limit}`, { headers: H }),
    );
  const any = await facet('impersonator', 'impersonator:*', 20);
  const anyTotal = any.values.reduce((n, v) => n + v.count, 0) + any.otherCount;
  check('presence row = every support event, with 22 agents > 20 listed', anyTotal === SUPPORT_EVENTS && any.values.length === 20, {
    listed: any.values.length,
    otherCount: any.otherCount,
    anyTotal,
    blank: any.values.some((v) => v.value === ''),
  });
  const actedAs = await facet('actor', `impersonator:${agentId(0)} actor:*`, 100);
  const tenants = await facet('tenant', `impersonator:${agentId(0)} tenant:*`, 100);
  check('agent page: support events with no actor/tenant are not a customer/tenant', actedAs.values.length === 1 && tenants.values.length === 1, {
    customers: actedAs.values.map((v) => v.value),
    tenants: tenants.values.map((v) => v.value),
  });

  /* ---------------- facet semantics in the UI (M1) ---------------- */
  await page.goto(P('/events', '-impersonator:*'));
  await settle(page);
  const group = page.locator('section', { has: page.getByRole('button', { name: /Done by support/ }) }).first();
  // n5: a stable name plus aria-pressed (APG toggle), not a label that also changes with the state.
  check(
    '− on "Any support agent" is a pressed toggle with a stable name',
    (await group.locator('button[aria-label="Hide what support did"][aria-pressed="true"]').count()) === 1,
  );
  await group
    .getByRole('button', { name: /QA Agent 02/ })
    .first()
    .click();
  await settle(page, 500);
  const q1 = new URL(page.url()).searchParams.get('q');
  check('hidden support + click an agent → only that agent', q1 === `impersonator:${agentId(2)}`, q1);
  await group.getByRole('button', { name: /Any support agent/ }).click({ modifiers: ['Alt'] });
  await settle(page, 500);
  const q2 = new URL(page.url()).searchParams.get('q');
  check('an agent + Alt-click "Any support agent" → support hidden, agent dropped', q2 === '-impersonator:*', q2);

  /* ---------------- keyboard on the grid (M3) ---------------- */
  await page.goto(P('/events', 'impersonator:*'));
  await settle(page);
  const links = await page.evaluate(() => ({
    inRows: document.querySelectorAll('[role=row] a[href*="/support/"]').length,
    tabbable: document.querySelectorAll('[role=row] a[href*="/support/"]:not([tabindex="-1"])').length,
  }));
  check('support links in rows are not tab stops', links.inRows > 0 && links.tabbable === 0, links);
  await page
    .locator('[role="search"] input, [role="combobox"]')
    .first()
    .focus()
    .catch(() => undefined);
  const presses = await enterGrid(page);
  const row = await focused(page);
  check('row name says who was at the keyboard', row.role === 'row' && /done by support agent .+ while acting as /.test(row.label), row.label);
  await page.keyboard.press('Tab');
  const after = await focused(page);
  check('Tab from a row leaves the grid (no stop on the in-row links)', !after.inGrid, after);
  await page.keyboard.press('Shift+Tab');
  check('Shift+Tab returns to the row', (await focused(page)).role === 'row', presses);
  await page.keyboard.press('Enter');
  await settle(page, 400);
  check('Enter on a row opens the event sheet', Boolean(new URL(page.url()).searchParams.get('ev')));
  await page.keyboard.press('Escape');
  await settle(page, 400);
  check('Escape returns focus to the row', (await focused(page)).role === 'row');
  const before = await page.evaluate(() => history.length);
  await page.locator('[role=row] a[href*="/support/"]').first().focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/support\//, { timeout: 10_000 });
  const pushed = (await page.evaluate(() => history.length)) - before;
  const evOnAgent = new URL(page.url()).searchParams.get('ev');
  await page.goBack();
  await settle(page, 500);
  check('Enter on a support link opens only the agent page', pushed === 1 && !evOnAgent && !new URL(page.url()).searchParams.get('ev'), {
    historyEntries: pushed,
    backEv: new URL(page.url()).searchParams.get('ev'),
  });

  // Count the rows the explorer has loaded (every events page it fetched), then Ctrl+End must land on the last one.
  let loaded = 0;
  const countPages = async (res) => {
    if (!/\/api\/projects\/[^/]+\/events\?/.test(res.url()) || res.request().method() !== 'GET') return;
    const body = await res.json().catch(() => null);
    if (Array.isArray(body?.data)) loaded += body.data.length;
  };
  page.on('response', countPages);
  await page.goto(P('/events'));
  await settle(page);
  await page.locator('[role=row][data-index="0"]').focus();
  // Reaching the end may load the next page; Ctrl+End targets the last row loaded when it was pressed.
  const loadedAtPress = loaded;
  await page.keyboard.press('Control+End');
  await page.waitForTimeout(600);
  await settle(page, 300);
  const last = await focused(page);
  page.off('response', countPages);
  check(
    'Ctrl+End lands on exactly the last loaded row (10,051-event result)',
    last.role === 'row' && loadedAtPress > 1 && last.index === loadedAtPress - 1,
    { loadedAtPress, loadedAfter: loaded, focusedIndex: last.index },
  );

  /* ---------------- round 3: OR on the agent page, default range, failures ---------------- */
  // M1: the agent page's timeline with a user OR lists only that agent's events (failures exist outside support).
  const orRequests = [];
  const recordSearch = (req) => {
    if (/\/events\?/.test(req.url())) orRequests.push(new URL(req.url()).searchParams.get('q'));
  };
  page.on('request', recordSearch);
  await page.goto(`${BASE}/p/${projectId}/support/${agentId(3)}?range=1h&q=${encodeURIComponent('outcome:failure OR outcome:success')}`);
  await settle(page, 1200);
  page.off('request', recordSearch);
  const orRows = await page.$$eval('[role=row][data-index]', (rows) => rows.map((r) => r.getAttribute('aria-label') ?? ''));
  check(
    "agent page + user OR: the request parenthesises the OR and only the agent's events come back",
    orRows.length === 2 &&
      orRows.every((l) => l.includes('QA Agent 03')) &&
      orRequests.some((q) => q === `impersonator:${agentId(3)} (outcome:failure OR outcome:success)`),
    {
      rows: orRows.length,
      q: orRequests.at(-1),
    },
  );

  // M2: the agent page opens on 7 days.
  await page.goto(`${BASE}/p/${projectId}/support/${agentId(2)}`);
  await settle(page, 1200);
  check('agent page defaults to the last 7 days', (await page.getByText('Done as support · Last 7 days').count()) === 1);

  // M2/m3: a summary query over budget → page banner + "Couldn't load" in that panel; Retry recovers everything.
  let failActions = true;
  let actionHits = 0;
  await page.route(/\/facets\?.*field=action/, (route) => {
    if (failActions) actionHits += 1;
    return failActions
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'query_unavailable', message: 'Storage query failed or exceeded its budget. Narrow the time range and retry.' },
          }),
        })
      : route.continue();
  });
  const opened = Date.now();
  await page.goto(`${BASE}/p/${projectId}/support/${agentId(2)}?range=30d`);
  const banner = page.getByTestId('agent-page-failure');
  // m2: an over-budget summary is not retried: the banner shows at once and the scan ran exactly once.
  await banner.waitFor({ timeout: 10_000 });
  const bannerAfterMs = Date.now() - opened;
  await settle(page, 2500);
  check('an over-budget summary is never auto-retried: one request, banner without retry delay', actionHits === 1 && bannerAfterMs < 6000, {
    requests: actionHits,
    bannerAfterMs,
  });
  // The panel around the "Top actions" title: walk up from the title until the element holds the panel body.
  const panelText = (title) =>
    page.evaluate((t) => {
      const el = [...document.querySelectorAll('body *')].find((n) => n.childElementCount === 0 && n.textContent?.trim() === t);
      let box = el;
      for (let i = 0; i < 6 && box; i++) {
        box = box.parentElement;
        if (box && (box.textContent ?? '').length > t.length + 2) break;
      }
      return box?.textContent ?? '';
    }, title);
  const bannerText = (await banner.textContent().catch(() => '')) ?? '';
  check(
    'a summary over budget shows the range banner with shorter ranges',
    /Couldn't summarise the last 30 days\. It may hold too many events\./.test(bannerText) &&
      /Try a shorter range, or retry\./.test(bannerText) &&
      /Last 7 days/.test(bannerText) &&
      /Last 24 hours/.test(bannerText),
    bannerText,
  );
  check(
    'the failed panel says "Couldn\'t load", not "Nothing in this range"',
    await panelText('Top actions').then((t) => t.includes("Couldn't load") && !t.includes('Nothing in this range')),
  );
  check(
    'the panels that loaded still show their data',
    (await page.getByText('Customers acted as').count()) === 1 && (await page.locator('svg.recharts-surface').count()) >= 1,
  );
  await page.screenshot({ path: path.join(OUT, 'after-desktop-light-agent-page-budget-banner.png') });
  failActions = false;
  await banner.getByRole('button', { name: 'Retry' }).focus();
  await page.keyboard.press('Enter');
  await settle(page, 1500);
  const afterRetry = await page.evaluate(() => document.activeElement?.tagName ?? null);
  check(
    'Retry refetches every failed query, clears the banner, and focus moves to the heading',
    (await banner.count()) === 0 && (await page.getByText("Couldn't load").count()) === 0 && afterRetry === 'H1',
    { focus: afterRetry },
  );
  await page.unroute(/\/facets\?.*field=action/);

  // n3: unknown agent → only the empty state (no callout, no zero tiles).
  await page.goto(`${BASE}/p/${projectId}/support/qa_support_nobody?range=1h`);
  await settle(page, 1200);
  check(
    'unknown agent: one empty state, no callout or tiles',
    (await page.getByText('No support activity in this range').count()) === 1 &&
      (await page.getByText('Customers acted as').count()) === 0 &&
      (await page.getByText('These are the actions').count()) === 0,
  );

  // M2: Ctrl K says when the agent lookup failed.
  await page.route(/\/suggest\?.*field=impersonator/, (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'query_unavailable', message: 'busy' } }) }),
  );
  await page.goto(P('/events'));
  await settle(page);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('QA Agent', { delay: 30 });
  const failedRow = await page
    .getByText("Couldn't search support agents. Try the explorer filter.")
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check('Ctrl K: a failed agent lookup says so', failedRow);
  await page.keyboard.press('Escape');
  await page.unroute(/\/suggest\?.*field=impersonator/);

  /* ---------------- axe, desktop light + dark ---------------- */
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(P('/events', 'impersonator:*'));
    await settle(page);
    await axe(page, `explorer support desktop-${theme}`);
    await page.locator('[role=row][data-index="0"]').click({ position: { x: 700, y: 12 } });
    await settle(page);
    await axe(page, `event-sheet support desktop-${theme}`, '[role="dialog"]');
    await page.goto(P(`/support/${agentId(0)}`));
    await settle(page, 1200);
    await axe(page, `support-agent page desktop-${theme}`);
    await page.goto(P('/actors/usr_long'));
    await settle(page, 1200);
    await axe(page, `actor split desktop-${theme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  // The 503s injected above (actions facet, agent lookup) are expected; anything else is a problem.
  const injected = /field=action|field=impersonator|status of 503/;
  note('console problems (desktop)', [...new Set(problems.filter((x) => !injected.test(x)))]);

  /* ---------------- 390px with long names ---------------- */
  for (const theme of ['light', 'dark']) {
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      colorScheme: theme,
      storageState: await ctx.storageState(),
    });
    const p = await phone.newPage();
    const phoneProblems = watch(p);
    try {
      await p.goto(P('/events', 'impersonator:*'));
      await settle(p);
      const fit = await p.evaluate(() => {
        const rows = [...document.querySelectorAll('[role=row][data-index]')];
        const spill = rows.filter((r) => {
          const box = r.getBoundingClientRect();
          return [...r.querySelectorAll('a[href*="/support/"]')].some((a) => a.getBoundingClientRect().right > box.right + 1);
        }).length;
        // m1: the pill and the action name next to it never overlap.
        const overlap = rows.filter((r) =>
          [...r.querySelectorAll('a[href*="/support/"]')].some((a) => {
            const next = a.nextElementSibling?.nextElementSibling ?? a.nextElementSibling;
            const action = a.parentElement?.lastElementChild;
            const x = a.getBoundingClientRect();
            return [next, action].some((el) => {
              if (!el || el === a) return false;
              const y = el.getBoundingClientRect();
              return y.width > 0 && x.left < y.right - 0.5 && y.left < x.right - 0.5 && x.top < y.bottom && y.top < x.bottom;
            });
          }),
        ).length;
        return { pageWidth: document.scrollingElement.scrollWidth, rows: rows.length, markersSpilling: spill, overlapping: overlap };
      });
      check(
        `390px ${theme}: long names fit (no page scroll, markers inside rows, no pill/action overlap)`,
        fit.pageWidth <= 390 && fit.markersSpilling === 0 && fit.overlapping === 0,
        fit,
      );
      await p.screenshot({ path: path.join(OUT, `after-phone-${theme}-long-names-explorer.png`) });
      await p.goto(P(`/support/${agentId(0)}`));
      await settle(p, 1200);
      // m1 (round 3): the app scrolls inside its own container, so check every section's box, not the document width.
      const sections = await p.evaluate(() =>
        [...document.querySelectorAll('section')].map((el) => ({
          name: (el.querySelector('h2, h3, [data-slot=card-title]')?.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30),
          right: Math.round(el.getBoundingClientRect().right),
        })),
      );
      const spilling = sections.filter((x) => x.right > 390);
      check(`390px ${theme}: agent page fits (every section inside the screen)`, sections.length > 0 && spilling.length === 0, {
        sections: sections.length,
        spilling,
      });
      await p.screenshot({ path: path.join(OUT, `after-phone-${theme}-long-names-agent-page.png`) });
      await p.goto(P('/actors/usr_long'));
      await settle(p, 1200);
      await p.getByRole('group', { name: 'Who did it' }).scrollIntoViewIfNeeded();
      await p.waitForTimeout(300);
      const seg = await p.getByRole('group', { name: 'Who did it' }).evaluate((g) => ({
        width: Math.round(g.getBoundingClientRect().width),
        truncated: [...g.querySelectorAll('button')].some((b) => b.scrollWidth > b.clientWidth + 1),
        labels: [...g.querySelectorAll('button')].map((b) => b.innerText.trim()),
      }));
      check(`390px ${theme}: "Who did it" control is not cut short`, !seg.truncated, seg);
      await p.screenshot({ path: path.join(OUT, `after-phone-${theme}-long-names-actor.png`) });
      if (theme === 'light') {
        await p.goto(P('/events', 'impersonator:*'));
        await settle(p);
        await axe(p, 'explorer support phone-light');
      }
      note(`console problems (phone ${theme})`, [...new Set(phoneProblems)]);
    } finally {
      await phone.close();
    }
  }
} finally {
  if (projectId && api) {
    const res = await api
      .delete(`${BASE}/api/projects/${projectId}?confirm=${encodeURIComponent(projectSlug)}`, { headers: H })
      .catch((e) => ({ status: () => String(e) }));
    note('cleanup: QA project deleted', res.status());
  }
  await browser.close();
  await writeFile(path.join(OUT, 'round3-support-proof.txt'), `${log.join('\n')}\n`);
  await writeFile(path.join(OUT, 'round3-support-proof.json'), `${JSON.stringify(results, null, 2)}\n`);
}
process.exit(results.failed ? 1 : 0);
