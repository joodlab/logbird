/**
 * Keyboard + axe verification for the event grid against a local stack (app :4600, server :4601, worker).
 *
 *   AXE=/path/to/axe.min.js OUT=../../output/qa/2026-11-07-a11y-explorer node scripts/a11y-grid-proof.mjs
 *
 * Creates a fictional user/workspace/project (qa-fix-a11y-r5-*@example.test, "QA Fix a11y r5"), ingests events, and checks:
 *  - Explorer: keyboard into the grid, ArrowDown to row 50, a 150-event live-tail batch arrives → focus stays on the same
 *    event (same node, new index), the view does not jump, ArrowDown continues from that event, Enter/Escape round trip.
 *  - Workspace Activity: ArrowDown moves the roving tab stop; Shift+Tab out and Tab back returns to that row; the event
 *    sheet's Escape returns focus to it; the focused row survives a scroll far away.
 *  - Settings at 390px under dir=rtl: General → Danger zone → General keeps the active tab fully visible; the fade flips.
 *  - Scroll jump: cursor on row 90, mouse back to the top, a new query from the bar → the view stays at the top, no
 *    second page is fetched, and the tab stop is row 0 of the new results.
 *  - Empty results: a refetch that empties the list moves focus from a focused row to the query bar; the sheet closing
 *    over an emptied list does the same (the refetch is forced by intercepting the search and invalidating the query).
 *  - Ctrl+End / Ctrl+Home; forced colors keep a painted outline on the focused row; the query bar's static key hint,
 *    dir=ltr and the polite "Inserted …" announcement; Settings tabs focused by Tab at 390px clear the fade; the phone
 *    gridcell is a real flex box.
 *  - axe-core (wcag2a/aa, wcag21a/aa, wcag22aa, best-practice) on the changed screens, light and dark.
 *  - Forced colors: only the focused element computes an outline. No unfocused row, sidebar item, CopyValue or Settings
 *    tab does: Tailwind's `outline-hidden` paints a transparent outline in forced colors, so it must be focus-only.
 *    Shoots the focused row (after) and the same screen with baseline classes put back (before).
 *  - "Filter by…" from the sheet, with the filtered response held back so focus returns to the old row first (the
 *    race): focus lands on row 0 of the new results, the view at the top, and no second page is fetched. When the new
 *    results still hold the open event, focus stays on it at its new index, scrolled into view.
 *  - "Filter by" a common value (the newest event's tenant) from row ≈ 299, under the same race: the old first row is
 *    row 0 of the new results too, and focus still lands there, the view at the top, with no second page.
 *  - A new query while focus is in the query bar, with the cursor's event surviving further down: the view stays at the
 *    top, no second page; Tab back in lands on that event, in view.
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
const EMAIL = `qa-fix-a11y-r5-${Date.now().toString(36)}@example.test`;
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
    // Two fictional tenants: "Filter by tenant" then matches half the events, more than one page of them.
    tenant: { id: `tn_qa_${i % 2}`, name: `QA Tenant ${i % 2}` },
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

/** Tab from the current focus into the explorer grid, taking the "Skip filters to events" link past the facets. */
async function enterGrid(page, max = 60) {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press('Tab');
    const f = await focused(page);
    if (f.role === 'row') return i;
    if (/Skip filters to events/.test(f.name)) {
      await page.keyboard.press('Enter');
      return i + 1;
    }
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

/** In forced colors: the focused element's outline, and every other rendered element that computes one (should be none). */
const outlines = (page) =>
  page.evaluate(() => {
    const describe = (el) =>
      `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''} ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}`;
    const active = document.activeElement;
    const s = active ? getComputedStyle(active) : null;
    const others = [...document.querySelectorAll('body *')].filter(
      (el) => el !== active && el.getClientRects().length > 0 && getComputedStyle(el).outlineStyle !== 'none',
    );
    return {
      focused: s ? { el: describe(active), style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, color: s.outlineColor } : null,
      unfocusedOutlined: others.length,
      sample: others.slice(0, 12).map(describe),
    };
  });

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
      data: { name: 'QA Fix a11y r5', slug: `qa-fix-a11y-r5-${Date.now().toString(36)}` },
    }),
  );
  await json(await api.post(`${BASE}/api/auth/organization/set-active`, { headers: H, data: { organizationId: org.id } }));
  const created = await json(await api.post(`${BASE}/api/projects`, { headers: H, data: { name: 'QA a11y r5 grid' } }));
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
  note('fixture', { email: EMAIL.replace(/-[a-z0-9]+@/, '-*@'), workspace: 'QA Fix a11y r5', events: await waitFor(400) });

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

  /* ---------------- the query bar's description, direction and accept announcement ---------------- */
  {
    const bar = page.getByRole('combobox', { name: 'Query' });
    const meta = await bar.evaluate((el) => {
      const id = el.getAttribute('aria-describedby');
      return { describedby: id, hint: id ? (document.getElementById(id)?.textContent ?? null) : null, dir: el.getAttribute('dir') };
    });
    check('query: a static key hint is described on focus, dir=ltr', Boolean(meta.hint) && meta.dir === 'ltr', meta);
    await bar.fill('');
    await bar.focus();
    await page.keyboard.type('outc', { delay: 40 });
    await page.waitForTimeout(800);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const announced = await page.evaluate(() => [...document.querySelectorAll('[aria-live="polite"]')].map((n) => n.textContent ?? '').join(' | '));
    check('query: accepting a suggestion is announced politely', /Inserted outcome:/.test(announced), {
      draft: await bar.inputValue(),
      announced: announced.replace(/​/g, ''),
    });
  }

  /* ---------------- no scroll jump on a new result set ---------------- */
  {
    await page.goto(`${BASE}/p/${projectId}/events?range=1h`);
    await settle(page);
    await page.getByRole('combobox', { name: 'Query' }).focus();
    await enterGrid(page);
    for (let i = 0; i < 90; i++) await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(600);
    const cur = await focused(page);
    const wasFailure = /, failure,/.test(cur.name);
    // The reader scrolls back to the top with the mouse wheel, clicks into the query bar and runs a new query.
    // Over the grid's scroll container (the grid element itself is as tall as all its rows).
    const box = await page.$eval('[role="grid"]', (g) => {
      const r = (g.parentElement ?? g).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + Math.min(200, r.height / 2) };
    });
    await page.mouse.move(box.x, box.y);
    for (let i = 0; i < 40 && (await scrollTop(page)) > 0; i++) {
      await page.mouse.wheel(0, -2000);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(600);
    const topBefore = await scrollTop(page);
    const pageRequests = [];
    const onRequest = (req) => {
      if (/\/api\/projects\/[^/]+\/events\?/.test(req.url()) && /[?&]cursor=/.test(req.url())) pageRequests.push(req.url());
    };
    page.on('request', onRequest);
    await page.getByRole('combobox', { name: 'Query' }).click();
    const nextQuery = wasFailure ? 'outcome:success' : 'outcome:failure';
    await page.keyboard.type(nextQuery, { delay: 20 });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await page.waitForFunction((q) => new URL(location.href).searchParams.get('q') === q, nextQuery, { timeout: 10_000 });
    await settle(page, 1500);
    page.off('request', onRequest);
    const topAfter = await scrollTop(page);
    const stops = await tabStops(page);
    const first = await page.$eval('[role="row"][data-index="0"]', (r) => r.getAttribute('data-event-id'));
    const active = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    check(
      'scroll jump: a new query keeps the view at the top, fetches no second page, tab stop on row 0',
      cur.index === 90 && topBefore === 0 && topAfter === 0 && pageRequests.length === 0 && stops.length === 1 && stops[0] === first,
      {
        cursorBefore: `row ${cur.index} (${wasFailure ? 'failure' : 'success'})`,
        query: nextQuery,
        scrollTop: `${topBefore} → ${topAfter}`,
        pageRequests: pageRequests.length,
        tabStops: stops,
        row0: first,
        focus: active,
      },
    );
    const entered = await enterGrid(page);
    const landed = await focused(page);
    check('scroll jump: Tab into the new results lands on row 0', landed.index === 0, { presses: entered, index: landed.index });

    /* Ctrl+End / Ctrl+Home */
    const count = await page.$eval('[role="grid"]', () => document.querySelectorAll('[role="row"][data-index]').length);
    await page.keyboard.press('Control+End');
    await page.waitForTimeout(500);
    const end = await focused(page);
    await page.keyboard.press('Control+Home');
    await page.waitForTimeout(500);
    const home = await focused(page);
    check('grid: Ctrl+End → last loaded row, Ctrl+Home → row 0', end.index !== null && end.index > 0 && home.index === 0, {
      end: end.index,
      home: home.index,
      renderedRows: count,
    });

    /* forced colors: the focus indicator is an outline Windows High Contrast can paint — on the focused row only */
    await page.emulateMedia({ forcedColors: 'active' });
    await page.waitForTimeout(200);
    const fc = await outlines(page);
    const row1 = await page.$eval('[role="row"][data-index="1"]', (r) => getComputedStyle(r).outlineStyle);
    check(
      'forced colors: the focused row keeps a painted outline, inset so neighbouring rows cannot cover it',
      Boolean(fc.focused) && fc.focused.style !== 'none' && fc.focused.width !== '0px' && Number.parseFloat(fc.focused.offset) < 0,
      fc.focused,
    );
    check('forced colors: an unfocused row computes outline-style none', row1 === 'none', { row1 });
    check('forced colors (explorer): no unfocused element (rows, sidebar, toolbar) is outlined', fc.unfocusedOutlined === 0, fc);
    await page.screenshot({ path: path.join(OUT, 'after-forced-colors-row-focus-desktop.png') });
    // Before: the same screen with baseline classes put back, and the same row focused. The PR's controls had
    // `outline-none`; the shadcn sidebar and chart had their unconditional `outline-hidden`.
    const restored = await page.evaluate(() => {
      const els = [...document.querySelectorAll('[class*="focus-visible:outline-hidden"]')];
      for (const el of els) {
        el.classList.remove('focus-visible:outline-hidden', 'focus-visible:forced-colors:-outline-offset-2');
        if (el.classList.contains('ring-sidebar-ring')) {
          el.classList.remove('outline-none');
          el.classList.add('outline-hidden');
        }
      }
      // The shadcn chart's round-2 `[&_.recharts-*]:outline-hidden` (no longer in the compiled CSS): the same rule.
      const style = document.createElement('style');
      style.textContent =
        '.recharts-layer,.recharts-surface,.recharts-sector{outline-style:none}@media (forced-colors: active){.recharts-layer,.recharts-surface,.recharts-sector{outline:2px solid transparent;outline-offset:2px}}';
      document.head.append(style);
      return els.length;
    });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, 'before-forced-colors-row-focus-desktop.png') });
    note('forced colors: round-2 classes put back for the before shot on', `${restored} elements`);
    // The event sheet's CopyValues and other controls under forced colors: nothing but the focused element is outlined.
    await page.goto(`${BASE}/p/${projectId}/events?range=1h`);
    await settle(page);
    await page.getByRole('combobox', { name: 'Query' }).focus();
    await enterGrid(page);
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(400);
    const sheetFc = await outlines(page);
    check('forced colors (event sheet): no unfocused CopyValue or control is outlined', sheetFc.unfocusedOutlined === 0, sheetFc);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await page.emulateMedia({ forcedColors: 'none' });
  }

  /* ---------------- "Filter by…" from the sheet, focus back on the old row before the results ---------------- */
  {
    const EVENTS = /\/api\/projects\/[^/]+\/events\?/;
    let hold = null;
    await page.route(EVENTS, async (route) => {
      const q = new URL(route.request().url()).searchParams.get('q') ?? '';
      if (hold && q.includes(hold)) await new Promise((r) => setTimeout(r, 2000));
      return route.continue();
    });
    const pageRequests = [];
    const onRequest = (req) => {
      if (EVENTS.test(req.url()) && /[?&]cursor=/.test(req.url())) pageRequests.push(req.url());
    };
    const qHas = (t) => page.waitForFunction((x) => (new URL(location.href).searchParams.get('q') ?? '').includes(x), t, { timeout: 10_000 });

    await page.goto(`${BASE}/p/${projectId}/events?range=1h`);
    await settle(page);
    await page.getByRole('combobox', { name: 'Query' }).focus();
    await enterGrid(page);
    // End, let the next page load, End again …: row 299.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('End');
      await page.waitForTimeout(1500);
    }
    const opened = await focused(page);
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(400);
    const tenantButton = page.getByRole('button', { name: /^Filter by tenant:/ });
    const term = ((await tenantButton.getAttribute('aria-label')) ?? '').replace(/^Filter by /, '');
    hold = term;
    page.on('request', onRequest);
    await tenantButton.focus();
    await page.keyboard.press('Enter');
    // The filtered results are held back for 2 s: the sheet closes and returns focus to the old row first.
    await page.waitForTimeout(800);
    const whileLoading = await focused(page);
    await qHas(term);
    await page.waitForTimeout(2000);
    await settle(page, 1500);
    page.off('request', onRequest);
    const landed = await focused(page);
    const top = await scrollTop(page);
    const stops = await tabStops(page);
    const total = await page.$eval('[role="grid"]', (g) => Number(g.getAttribute('aria-rowcount')) - 1);
    check(
      'filter by (race): focus lands on row 0 of the new results, view at the top, no second page',
      opened.index === 299 &&
        whileLoading.eventId === opened.eventId &&
        landed.index === 0 &&
        top === 0 &&
        pageRequests.length === 0 &&
        stops.length === 1 &&
        stops[0] === landed.eventId,
      {
        opened: `row ${opened.index}`,
        term,
        focusWhileLoading: `row ${whileLoading.index} (${whileLoading.eventId === opened.eventId ? 'the old row' : 'elsewhere'})`,
        landed: `row ${landed.index}`,
        scrollTop: top,
        pageRequests: pageRequests.length,
        tabStops: stops,
        newTotal: total,
      },
    );
    // Release the hold: it would also delay the filtered list's next pages below.
    hold = null;
    await page.keyboard.press('ArrowDown');
    check('filter by (race): ArrowDown continues from row 0', (await focused(page)).index === 1, (await focused(page)).index);

    // The new results still hold the open event (its own operation): focus stays on it at its new index, in view.
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press('End');
      await page.waitForTimeout(1500);
    }
    const second = await focused(page);
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(400);
    const opButton = page.getByRole('button', { name: /^Filter by operation:/ });
    const opTerm = ((await opButton.getAttribute('aria-label')) ?? '').replace(/^Filter by /, '');
    hold = opTerm;
    pageRequests.length = 0;
    page.on('request', onRequest);
    await opButton.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    const whileLoading2 = await focused(page);
    await qHas(opTerm);
    await page.waitForTimeout(2000);
    await settle(page, 1500);
    page.off('request', onRequest);
    const kept = await focused(page);
    const inView = await page.evaluate(() => {
      const row = document.activeElement?.closest('[role="row"]');
      const box = document.querySelector('[role="grid"]')?.parentElement?.getBoundingClientRect();
      const r = row?.getBoundingClientRect();
      return Boolean(r && box && r.top >= box.top && r.bottom <= box.bottom);
    });
    check(
      'filter by (event still in the results): focus stays on it at its new index, scrolled into view',
      second.index > 100 &&
        whileLoading2.eventId === second.eventId &&
        kept.eventId === second.eventId &&
        kept.index === 0 &&
        inView &&
        pageRequests.length === 0,
      {
        opened: `row ${second.index}`,
        term: opTerm,
        focusWhileLoading: `row ${whileLoading2.index}`,
        now: `row ${kept.index}`,
        sameEvent: kept.eventId === second.eventId,
        inView,
        pageRequests: pageRequests.length,
      },
    );
    await page.unroute(EVENTS);
  }

  /* ---------------- "Filter by" a common value, and a surviving cursor with focus elsewhere ---------------- */
  {
    const EVENTS = /\/api\/projects\/[^/]+\/events\?/;
    let hold = null;
    await page.route(EVENTS, async (route) => {
      const q = new URL(route.request().url()).searchParams.get('q') ?? '';
      if (hold && q.includes(hold)) await new Promise((r) => setTimeout(r, 2000));
      return route.continue();
    });
    const pageRequests = [];
    const onRequest = (req) => {
      if (EVENTS.test(req.url()) && /[?&]cursor=/.test(req.url())) pageRequests.push(req.url());
    };
    const qIs = (t) => page.waitForFunction((x) => (new URL(location.href).searchParams.get('q') ?? '') === x, t, { timeout: 10_000 });
    /** Open the focused row's sheet and read its "Filter by tenant:" term; the sheet stays open. */
    const openTenant = async () => {
      await page.keyboard.press('Enter');
      await page.waitForSelector('[role="dialog"]');
      await page.waitForTimeout(300);
      const label = (await page.getByRole('button', { name: /^Filter by tenant:/ }).getAttribute('aria-label')) ?? '';
      return label.replace(/^Filter by /, '');
    };
    const closeSheet = async () => {
      await page.keyboard.press('Escape');
      await page.waitForSelector('[role="dialog"]', { state: 'detached' });
      await page.waitForTimeout(300);
    };

    // A common value: the tenant of the newest event (row 0), which half the events share.
    await page.goto(`${BASE}/p/${projectId}/events?range=1h`);
    await settle(page);
    await page.getByRole('combobox', { name: 'Query' }).focus();
    await enterGrid(page);
    const row0 = await focused(page);
    const common = await openTenant();
    await closeSheet();
    // End, let the next page load, End again …: row 299; then up to the nearest row with that tenant.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('End');
      await page.waitForTimeout(1500);
    }
    let term = await openTenant();
    for (let i = 0; i < 12 && term !== common; i++) {
      await closeSheet();
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(150);
      term = await openTenant();
    }
    // The sheet has focus: the opened row is the grid's tab stop.
    const openedId = (await tabStops(page))[0];
    const opened = {
      eventId: openedId,
      index: await page.$eval(`[role="row"][data-event-id="${openedId}"]`, (r) => Number(r.getAttribute('data-index'))),
    };
    hold = term;
    page.on('request', onRequest);
    const tenantButton = page.getByRole('button', { name: /^Filter by tenant:/ });
    await tenantButton.focus();
    await page.keyboard.press('Enter');
    // The filtered results are held back for 2 s: the sheet closes and returns focus to the old row first.
    await page.waitForTimeout(800);
    const whileLoading = await focused(page);
    await page.waitForFunction((x) => (new URL(location.href).searchParams.get('q') ?? '').includes(x), term, { timeout: 10_000 });
    await page.waitForTimeout(2000);
    await settle(page, 1500);
    page.off('request', onRequest);
    hold = null;
    const landed = await focused(page);
    const top = await scrollTop(page);
    const stops = await tabStops(page);
    const openedLoaded = await page.$(`[role="row"][data-event-id="${opened.eventId}"]`).then(Boolean);
    check(
      'filter by a common value (race): the old first row is row 0 again; focus lands on it, view at the top, no second page',
      term === common &&
        opened.index > 200 &&
        whileLoading.eventId === opened.eventId &&
        !openedLoaded &&
        landed.index === 0 &&
        landed.eventId === row0.eventId &&
        top === 0 &&
        pageRequests.length === 0 &&
        stops.length === 1 &&
        stops[0] === landed.eventId,
      {
        row0: row0.eventId,
        term,
        opened: `row ${opened.index}`,
        focusWhileLoading: `row ${whileLoading.index} (${whileLoading.eventId === opened.eventId ? 'the old row' : 'elsewhere'})`,
        openedEventOnPage1: openedLoaded,
        landed: `row ${landed.index} (${landed.eventId === row0.eventId ? 'the old first row' : landed.eventId})`,
        scrollTop: top,
        pageRequests: pageRequests.length,
        tabStops: stops,
      },
    );

    // Focus elsewhere, the cursor's event survives at another index: the view stays at the top.
    await page.goto(`${BASE}/p/${projectId}/events?range=1h&q=${encodeURIComponent('outcome:failure')}`);
    await settle(page);
    await page.getByRole('combobox', { name: 'Query' }).focus();
    await enterGrid(page);
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    const cursor = await focused(page);
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role="dialog"]');
    await closeSheet();
    const bar = page.getByRole('combobox', { name: 'Query' });
    await bar.click();
    const topBefore = await scrollTop(page);
    pageRequests.length = 0;
    page.on('request', onRequest);
    await bar.fill('');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await qIs('');
    await settle(page, 1500);
    page.off('request', onRequest);
    const topAfter = await scrollTop(page);
    const stops2 = await tabStops(page);
    const survived = await page.$eval(`[role="row"][data-event-id="${cursor.eventId}"]`, (r) => Number(r.getAttribute('data-index'))).catch(() => -1);
    const active = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    check(
      'new query, focus elsewhere: the cursor event survives further down, the view stays at the top, no second page',
      cursor.index === 8 &&
        survived >= 25 &&
        topBefore === 0 &&
        topAfter === 0 &&
        pageRequests.length === 0 &&
        stops2.length === 1 &&
        stops2[0] === cursor.eventId &&
        active === 'Query',
      {
        cursor: `row ${cursor.index} of outcome:failure`,
        nowAt: `row ${survived}`,
        scrollTop: `${topBefore} → ${topAfter}`,
        pageRequests: pageRequests.length,
        tabStops: stops2,
        focus: active,
      },
    );
    // Tab back in brings the cursor row into view.
    const presses = await enterGrid(page);
    const via = await page.evaluate(() => document.activeElement?.getAttribute('role'));
    const view = () =>
      page.evaluate(() => {
        const row = document.activeElement?.closest('[role="row"]');
        const scroller = document.querySelector('[role="grid"]')?.parentElement;
        const box = scroller?.getBoundingClientRect();
        const r = row?.getBoundingClientRect();
        return {
          // 1 px of slack: align 'auto' puts a row scrolled up from below on the bottom edge (subpixel rounding).
          inView: Boolean(r && box && r.top >= box.top && r.bottom <= box.bottom + 1),
          scrollTop: scroller?.scrollTop ?? null,
          row: r ? `${Math.round(r.top)}–${Math.round(r.bottom)}` : null,
          box: box ? `${Math.round(box.top)}–${Math.round(box.bottom)}` : null,
        };
      });
    const now = await view();
    await page.waitForTimeout(500);
    const later = await view();
    const back = await focused(page);
    check('new query, focus elsewhere: Tab back in lands on that event, in view', back.eventId === cursor.eventId && later.inView, {
      index: back.index,
      presses,
      via,
      immediately: now,
      after500ms: later,
    });
    await page.unroute(EVENTS);
  }

  /* ---------------- empty results never drop focus to <body> ---------------- */
  {
    const invalidate = () =>
      page.evaluate(() => window.__TSR_ROUTER__?.options.context.queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes('events') }));
    let empty = false;
    await page.route(/\/api\/projects\/[^/]+\/events\?/, async (route) => {
      if (!empty) return route.continue();
      const res = await route.fetch();
      const body = await res.json();
      return route.fulfill({ response: res, json: { ...body, data: [], total: 0, nextCursor: null } });
    });
    await page.goto(`${BASE}/p/${projectId}/events?range=1h`);
    await settle(page);
    await page.getByRole('combobox', { name: 'Query' }).focus();
    await enterGrid(page);
    await page.keyboard.press('ArrowDown');
    const onRow = await focused(page);
    empty = true;
    await invalidate();
    await page.waitForFunction(() => !document.querySelector('[role="grid"]'), undefined, { timeout: 10_000 });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      role: document.activeElement?.getAttribute('role'),
      label: document.activeElement?.getAttribute('aria-label'),
      body: document.activeElement === document.body,
    }));
    check('empty: a refetch emptying the list moves focus from the row to the query bar', onRow.role === 'row' && after.role === 'combobox', {
      from: `row ${onRow.index}`,
      to: after,
    });

    empty = false;
    await page.goto(`${BASE}/p/${projectId}/events?range=1h`);
    await settle(page);
    await page.getByRole('combobox', { name: 'Query' }).focus();
    await enterGrid(page);
    await page.keyboard.press('Enter');
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(400);
    empty = true;
    await invalidate();
    await page.waitForFunction(() => !document.querySelector('[role="grid"]'), undefined, { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    const closed = await page.evaluate(() => ({
      dialog: Boolean(document.querySelector('[role="dialog"]')),
      role: document.activeElement?.getAttribute('role'),
      body: document.activeElement === document.body,
    }));
    check('empty: the sheet closing over an emptied list returns focus to the query bar', !closed.dialog && closed.role === 'combobox', closed);
    await page.unroute(/\/api\/projects\/[^/]+\/events\?/);
  }

  /* ---------------- rescans of the other screens the PR touches ---------------- */
  const screenAxe = async (url, name) => {
    await page.goto(url);
    await settle(page);
    await axe(page, name);
  };
  // On the explorer: open row 0's event sheet and scan the dialog.
  const sheetAxe = async (name) => {
    await page.locator('[role="row"][data-index="0"]').click();
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(400);
    await axe(page, name, '[role="dialog"]');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  };
  await screenAxe(`${BASE}/p/${projectId}`, 'overview desktop-light');
  await screenAxe(`${BASE}/p/${projectId}/settings/keys`, 'settings-keys desktop-light');

  /* ---------------- dark theme axe ---------------- */
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${BASE}/p/${projectId}/events?range=1h`);
  await settle(page);
  await axe(page, 'explorer desktop-dark');
  await sheetAxe('event-sheet desktop-dark');
  await page.goto(`${BASE}/p/${projectId}/settings/activity`);
  await settle(page);
  await axe(page, 'activity desktop-dark');
  await screenAxe(`${BASE}/p/${projectId}`, 'overview desktop-dark');
  await screenAxe(`${BASE}/p/${projectId}/settings/keys`, 'settings-keys desktop-dark');

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
  // Tab through the strip — each focused (inactive) tab is scrolled clear of the 28px fades, not just to the edge.
  {
    await page.evaluate(() => {
      document.documentElement.dir = 'ltr';
    });
    await page.goto(`${BASE}/p/${projectId}/settings`);
    await settle(page);
    await page.locator('nav[aria-label="Settings sections"] a').first().focus();
    const seen = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(250);
      seen.push(
        await page.$eval('nav[aria-label="Settings sections"]', (nav) => {
          const a = document.activeElement;
          if (!a || !nav.contains(a)) return { tab: null };
          const n = nav.getBoundingClientRect();
          const r = a.getBoundingClientRect();
          const atStart = nav.scrollLeft <= 0;
          const atEnd = nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 1;
          return {
            tab: a.textContent,
            clear: r.left >= n.left + (atStart ? 0 : 28) - 1 && r.right <= n.right - (atEnd ? 0 : 28) + 1,
            span: `${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(n.left)}–${Math.round(n.right)}`,
          };
        }),
      );
    }
    check(
      'settings 390px: each Tab-focused tab clears the fade',
      seen.every((s) => s.tab && s.clear),
      seen,
    );
    await page.emulateMedia({ forcedColors: 'active' });
    await page.waitForTimeout(200);
    const settingsFc = await outlines(page);
    await page.emulateMedia({ forcedColors: 'none' });
    check(
      'forced colors (settings 390px): only the focused tab is outlined, inset',
      Boolean(settingsFc.focused) &&
        settingsFc.focused.style !== 'none' &&
        Number.parseFloat(settingsFc.focused.offset) < 0 &&
        settingsFc.unfocusedOutlined === 0,
      settingsFc,
    );
  }
  await page.evaluate(() => {
    document.documentElement.dir = 'ltr';
  });
  await page.goto(`${BASE}/p/${projectId}/events?range=1h`);
  await settle(page);
  const phoneCell = await page.$eval('[role="row"][data-index="0"]', (row) => {
    const cells = row.querySelectorAll('[role="gridcell"]');
    return { cells: cells.length, display: cells[0] ? getComputedStyle(cells[0]).display : null, ariaSelected: row.hasAttribute('aria-selected') };
  });
  check(
    'phone: one real gridcell per row (display flex, not contents), no aria-selected',
    phoneCell.cells === 1 && phoneCell.display === 'flex' && !phoneCell.ariaSelected,
    phoneCell,
  );
  await axe(page, 'explorer phone-light');
  await sheetAxe('event-sheet phone-light');
  await screenAxe(`${BASE}/p/${projectId}/settings/keys`, 'settings-keys phone-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await screenAxe(`${BASE}/p/${projectId}/events?range=1h`, 'explorer phone-dark');
  await sheetAxe('event-sheet phone-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  note('console problems', [...new Set(problems)]);
} finally {
  if (projectId && api) {
    const res = await api
      .delete(`${BASE}/api/projects/${projectId}?confirm=${encodeURIComponent(projectSlug)}`, { headers: H })
      .catch((e) => ({ status: () => String(e) }));
    note('cleanup: QA project deleted', res.status());
  }
  await browser.close();
  await writeFile(path.join(OUT, 'round5-proof.txt'), `${log.join('\n')}\n`);
  await writeFile(path.join(OUT, 'round5-proof.json'), `${JSON.stringify(results, null, 2)}\n`);
}
process.exit(results.failed ? 1 : 0);
