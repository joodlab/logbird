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
 *    Ctrl+End over 10k rows;
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
  const violations = res.violations.map((v) => ({ id: v.id, nodes: v.nodes.length, sample: v.nodes.slice(0, 2).map((n) => n.target.join(' ')) }));
  results.axe = results.axe ?? {};
  results.axe[name] = violations;
  note(`axe ${name}`, violations.length ? violations.map((v) => `${v.id}(${v.nodes}) ${v.sample.join(' | ')}`).join(', ') : '0');
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
  check(
    '− on "Any support agent" says what it will do when active',
    (await group.getByRole('button', { name: 'Show what support did again' }).count()) === 1,
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

  await page.goto(P('/events'));
  await settle(page);
  await page.locator('[role=row][data-index="0"]').focus();
  await page.keyboard.press('Control+End');
  await page.waitForTimeout(600);
  const last = await focused(page);
  check('Ctrl+End over 10k rows lands on the last loaded row', last.role === 'row' && last.index > 0, last.index);

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
  note('console problems (desktop)', [...new Set(problems)]);

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
        return { pageWidth: document.scrollingElement.scrollWidth, rows: rows.length, markersSpilling: spill };
      });
      check(`390px ${theme}: long names fit (no page scroll, markers inside rows)`, fit.pageWidth <= 390 && fit.markersSpilling === 0, fit);
      await p.screenshot({ path: path.join(OUT, `after-phone-${theme}-long-names-explorer.png`) });
      await p.goto(P(`/support/${agentId(0)}`));
      await settle(p, 1200);
      check(`390px ${theme}: agent page fits`, (await p.evaluate(() => document.scrollingElement.scrollWidth)) <= 390);
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
  await writeFile(path.join(OUT, 'round2-support-proof.txt'), `${log.join('\n')}\n`);
  await writeFile(path.join(OUT, 'round2-support-proof.json'), `${JSON.stringify(results, null, 2)}\n`);
}
process.exit(results.failed ? 1 : 0);
