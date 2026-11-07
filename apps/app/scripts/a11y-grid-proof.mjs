/**
 * Keyboard + axe proof for the event grid (PR #70, round 2), against a REAL local stack (app :4600, server :4601, worker).
 *
 *   AXE=/path/to/axe.min.js OUT=../../marketing/captures/2026-11-07-a11y-explorer node scripts/a11y-grid-proof.mjs
 *
 * Creates a fictional user/workspace/project (qa-fix-a11y-r2-*@example.test, "QA Fix a11y r2"), ingests events, and checks:
 *  - Explorer: keyboard into the grid, ArrowDown to row 50, a 150-event live-tail batch arrives → focus stays on the same
 *    event (same node, new index), the view does not jump, ArrowDown continues from that event, Enter/Escape round trip.
 *  - Workspace Activity: ArrowDown moves the roving tab stop; Shift+Tab out and Tab back returns to that row; the event
 *    sheet's Escape returns focus to it; the focused row survives a scroll far away.
 *  - Settings at 390px under dir=rtl: General → Danger zone → General keeps the active tab fully visible; the fade flips.
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
const EMAIL = `qa-fix-a11y-r2-${Date.now().toString(36)}@example.test`;
const ROW = 36;
/** Better Auth (and the API's CSRF guard) want the console's origin on mutating requests. */
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
  note(`${ok ? 'PASS' : 'FAIL'} ${name}`, detail);
  if (!ok) results.failed = (results.failed ?? 0) + 1;
}

const actors = ['Vera Validator', 'Omar Fictional', 'Lina Placeholder', 'Tariq Example'];
function events(prefix, n) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    action: i % 3 ? 'booking.modified' : 'booking.cancelled',
    occurredAt: new Date(now - i * 50).toISOString(),
    actor: { id: `usr_${i % 4}`, type: 'user', name: actors[i % 4] },
    targets: [{ type: 'booking', id: `${prefix}-${i}`, name: `BK-${prefix}-${i}` }],
    outcome: i % 7 ? 'success' : 'failure',
    description: `${actors[i % 4]} changed booking BK-${prefix}-${i}`,
    context: { operationId: `${prefix}-op-${i}` },
  }));
}

/** The focused element, described: its event id, row index and the row's top in the viewport. */
const focused = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    const row = el?.closest?.('[role="row"]');
    return {
      tag: el?.tagName ?? null,
      role: el?.getAttribute?.('role') ?? null,
      eventId: row?.getAttribute('data-event-id') ?? null,
      index: row ? Number(row.getAttribute('data-index')) : null,
      top: row ? Math.round(row.getBoundingClientRect().top) : null,
      tabIndex: row ? row.tabIndex : null,
      name: (el?.getAttribute?.('aria-label') ?? el?.textContent ?? '').slice(0, 80),
    };
  });
const tabStops = (page) => page.$$eval('[role="row"][tabindex="0"]', (rows) => rows.map((r) => r.getAttribute('data-event-id')));
const scrollTop = (page) => page.$eval('[role="grid"]', (g) => g.parentElement?.scrollTop ?? -1);

async function tabUntilRow(page, max = 40) {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press('Tab');
    const f = await focused(page);
    if (f.role === 'row') return i;
  }
  return -1;
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
    impact: v.impact,
    nodes: v.nodes.length,
    sample: v.nodes.slice(0, 2).map((n) => n.target.join(' ')),
  }));
  results.axe = results.axe ?? {};
  results.axe[name] = violations;
  note(`axe ${name}`, violations.length ? violations.map((v) => `${v.id}(${v.nodes})`).join(', ') : '0');
}

async function settle(page, ms = 800) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await page
    .waitForFunction(() => document.querySelectorAll('[data-slot=skeleton]').length === 0, undefined, { timeout: 15_000 })
    .catch(() => undefined);
  await page.waitForTimeout(ms);
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

  /* ---------------- fixture ---------------- */
  await signIn(page, EMAIL);
  const json = async (res) => {
    if (!res.ok()) throw new Error(`${res.url()} → ${res.status()} ${await res.text()}`);
    return res.status() === 204 ? null : res.json();
  };
  await json(await api.post(`${BASE}/api/auth/update-user`, { headers: H, data: { name: 'Rowan Fixture' } }));
  const org = await json(
    await api.post(`${BASE}/api/auth/organization/create`, {
      headers: H,
      data: { name: 'QA Fix a11y r2', slug: `qa-fix-a11y-r2-${Date.now().toString(36)}` },
    }),
  );
  await json(await api.post(`${BASE}/api/auth/organization/set-active`, { headers: H, data: { organizationId: org.id } }));
  const created = await json(await api.post(`${BASE}/api/projects`, { headers: H, data: { name: 'QA a11y r2 grid' } }));
  projectId = created.project.id;
  projectSlug = created.project.slug;
  await json(await api.patch(`${BASE}/api/projects/${projectId}`, { headers: H, data: { retentionReviewed: true } }));
  // Some Workspace Activity: key create + revoke pairs.
  for (let i = 0; i < 8; i++) {
    const key = await json(await api.post(`${BASE}/api/projects/${projectId}/keys`, { headers: H, data: { name: `QA read ${i}`, kind: 'read' } }));
    await json(await api.delete(`${BASE}/api/projects/${projectId}/keys/${key.key.id}`, { headers: H }));
  }
  const ingest = async (batch) => {
    const res = await fetch(`${SERVER}/v1/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.ingestKey.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (res.status !== 202) throw new Error(`ingest ${res.status} ${await res.text()}`);
  };
  await ingest(events('base', 400));
  const waitFor = async (n) => {
    for (let i = 0; i < 60; i++) {
      const r = await json(
        await api.get(`${BASE}/api/projects/${projectId}/events?from=${new Date(Date.now() - 3_600_000).toISOString()}&limit=1`, { headers: H }),
      );
      if ((r.total ?? 0) >= n) return r.total;
      await page.waitForTimeout(1000);
    }
    throw new Error(`events never reached ${n}`);
  };
  note('fixture', { email: EMAIL.replace(/-[a-z0-9]+@/, '-*@'), workspace: 'QA Fix a11y r2', events: await waitFor(400) });

  /* ---------------- Explorer: live tail keeps focus on its event ---------------- */
  await page.goto(`${BASE}/p/${projectId}/events?range=1h&live=true`);
  await settle(page, 1500);
  await page.keyboard.press('/');
  note('explorer / focuses', (await focused(page)).name);
  // The skip link sits in the facet column: Tab reaches it, Enter jumps to the grid.
  let presses = 0;
  for (; presses < 40; presses++) {
    await page.keyboard.press('Tab');
    const text = await page.evaluate(() => document.activeElement?.textContent ?? '');
    if (/Skip filters to events/.test(text)) {
      await page.keyboard.press('Enter');
      presses++;
      break;
    }
    if ((await focused(page)).role === 'row') break;
  }
  const entry = await focused(page);
  check('explorer: keyboard reaches the grid', entry.role === 'row', `${presses + 1} presses → row ${entry.index}`);
  for (let i = 0; i < 50; i++) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  const before = await focused(page);
  const top0 = await scrollTop(page);
  check('explorer: ArrowDown ×50 → row 50', before.index === 50, before);
  const nodeTagged = await page.evaluate(() => {
    document.activeElement?.setAttribute('data-proof-node', '1');
    return true;
  });
  // A live batch larger than the overscan (12) and the per-poll limit (100): it arrives over two polls.
  // Two batches a few seconds apart (each its own arrival time), 150 rows in all: arrives over at least two polls.
  await ingest(events('live-a', 80));
  await page.waitForTimeout(4000);
  await ingest(events('live-b', 70));
  await page
    .waitForFunction(() => /150 new since live started/.test(document.body.textContent ?? ''), undefined, { timeout: 30_000 })
    .catch(() => undefined);
  note('live pill', await page.evaluate(() => /([\d,]+) new since live started/.exec(document.body.textContent ?? '')?.[0] ?? 'none'));
  await page.waitForTimeout(600);
  const after = await focused(page);
  const top1 = await scrollTop(page);
  const sameNode = nodeTagged && (await page.evaluate(() => document.activeElement?.getAttribute('data-proof-node') === '1'));
  check('live tail: focus stays on the same event', after.eventId === before.eventId && sameNode, {
    before: before.eventId,
    after: after.eventId,
    sameNode,
  });
  check('live tail: its index moved by the batch', after.index === before.index + 150, `${before.index} → ${after.index}`);
  check('live tail: it is still the only tab stop', JSON.stringify(await tabStops(page)) === JSON.stringify([before.eventId]), await tabStops(page));
  check('live tail: no scroll jump (row stays put on screen)', Math.abs((after.top ?? 0) - (before.top ?? 0)) <= 1, {
    rowTop: `${before.top} → ${after.top}`,
    scrollTop: `${top0} → ${top1} (Δ ${top1 - top0} = ${(top1 - top0) / ROW} rows)`,
  });
  await page.keyboard.press('ArrowDown');
  const next = await focused(page);
  check('live tail: ArrowDown continues from that event', next.index === after.index + 1, next);
  await page.keyboard.press('k');
  check('live tail: k moves back to it', (await focused(page)).eventId === before.eventId, (await focused(page)).index);
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role="dialog"]');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  check('explorer: Escape returns focus to the opened row', (await focused(page)).eventId === before.eventId, await focused(page));
  await axe(page, 'explorer desktop-light (live)');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role="dialog"]');
  await page.waitForTimeout(400);
  await axe(page, 'event-sheet desktop-light', '[role="dialog"]');
  await page.keyboard.press('Escape');

  /* ---------------- Workspace Activity ---------------- */
  await page.goto(`${BASE}/p/${projectId}/settings/activity`);
  await settle(page);
  const activityRows = await page.$$eval('[role="row"][data-index]', (r) => r.length);
  note('activity rows rendered', activityRows);
  await page.getByLabel('Search workspace activity').focus();
  const toRow = await tabUntilRow(page);
  const a0 = await focused(page);
  check('activity: Tab reaches the grid', a0.role === 'row', `${toRow} presses → row ${a0.index}`);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  const a3 = await focused(page);
  check('activity: ArrowDown moves the roving tab stop', a3.index === 3 && a3.tabIndex === 0 && (await tabStops(page)).length === 1, {
    index: a3.index,
    tabStops: await tabStops(page),
  });
  await page.keyboard.press('Shift+Tab');
  const out = await focused(page);
  await page.keyboard.press('Tab');
  const back = await focused(page);
  check('activity: Shift+Tab out, Tab back → same row', out.role !== 'row' && back.eventId === a3.eventId, {
    out: out.name || out.tag,
    back: back.index,
  });
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role="dialog"]');
  await page.waitForTimeout(400);
  await axe(page, 'activity event-sheet desktop-light', '[role="dialog"]');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  check('activity: Escape returns focus to the opened row', (await focused(page)).eventId === a3.eventId, await focused(page));
  await page.$eval('[role="grid"]', (g) => {
    if (g.parentElement) g.parentElement.scrollTop = g.parentElement.scrollHeight;
  });
  await page.waitForTimeout(400);
  check('activity: focused row survives scrolling away', (await focused(page)).eventId === a3.eventId, await focused(page));
  await axe(page, 'activity desktop-light');

  /* ---------------- query bar: Tab leaves without rewriting the draft ---------------- */
  await page.goto(`${BASE}/p/${projectId}/events?range=1h`);
  await settle(page);
  await page.keyboard.press('/');
  await page.keyboard.type('outcome:failure OR ', { delay: 30 });
  await page.waitForTimeout(600);
  const draft = async () => page.getByRole('combobox', { name: 'Query' }).inputValue();
  const tabs = [];
  // Tab out of the bar, Shift+Tab back into it, Shift+Tab out the other way: the draft must survive each.
  for (const key of ['Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    const f = await focused(page);
    tabs.push({ key, draft: await draft(), focus: f.name || f.tag });
  }
  check(
    'query: Tab / Shift+Tab never edit the draft',
    tabs.every((t) => t.draft === 'outcome:failure OR '),
    tabs,
  );

  /* ---------------- dark theme axe ---------------- */
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${BASE}/p/${projectId}/events?range=1h`);
  await settle(page);
  await axe(page, 'explorer desktop-dark');
  await page.goto(`${BASE}/p/${projectId}/settings/activity`);
  await settle(page);
  await axe(page, 'activity desktop-dark');

  /* ---------------- phone: Settings strip under RTL ---------------- */
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const dir of ['ltr', 'rtl']) {
    await page.goto(`${BASE}/p/${projectId}/settings`);
    await settle(page);
    await page.evaluate((d) => {
      document.documentElement.dir = d;
    }, dir);
    await page.waitForTimeout(300);
    const strip = async () =>
      page.$eval('nav[aria-label="Settings sections"]', (nav) => {
        const active = nav.querySelector('[aria-current="page"]');
        const n = nav.getBoundingClientRect();
        const a = active?.getBoundingClientRect();
        return {
          active: active?.textContent ?? null,
          visible: Boolean(a && a.left >= n.left - 1 && a.right <= n.right + 1),
          span: a ? `${Math.round(a.left)}–${Math.round(a.right)} in ${Math.round(n.left)}–${Math.round(n.right)}` : null,
          scrollLeft: Math.round(nav.scrollLeft),
          mask: getComputedStyle(nav).maskImage.slice(0, 60),
        };
      });
    for (const tab of ['Danger zone', 'General']) {
      await page.locator('nav[aria-label="Settings sections"]').getByRole('link', { name: tab }).click();
      await page.waitForTimeout(500);
      const s = await strip();
      check(`settings ${dir} 390px → ${tab}: active tab fully visible`, s.active === tab && s.visible, s);
    }
    if (dir === 'ltr') await axe(page, 'settings phone-light');
  }
  await page.evaluate(() => {
    document.documentElement.dir = 'ltr';
  });
  await page.goto(`${BASE}/p/${projectId}/events?range=1h`);
  await settle(page);
  await axe(page, 'explorer phone-light');

  note('console problems', [...new Set(problems)]);
} finally {
  if (projectId && api) {
    const res = await api
      .delete(`${BASE}/api/projects/${projectId}?confirm=${encodeURIComponent(projectSlug)}`, { headers: H })
      .catch((e) => ({ status: () => String(e) }));
    note('cleanup: QA project deleted', res.status());
  }
  await browser.close();
  await writeFile(path.join(OUT, 'round2-proof.txt'), `${log.join('\n')}\n`);
  await writeFile(path.join(OUT, 'round2-proof.json'), `${JSON.stringify(results, null, 2)}\n`);
}
process.exit(results.failed ? 1 : 0);
