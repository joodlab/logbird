/**
 * Keyboard, screen-reader, forced-colors and axe proof for #85 + #64 (PHONE-07/08/09/12/13), against a REAL local
 * stack (app :4600, server :4601, worker).
 *
 *   MODE=before|after AXE=/path/to/axe.min.js OUT=../../output/qa/2026-11-08-console-a11y \
 *     node scripts/console-a11y-proof.mjs
 *
 * "before" runs against master's sources (checked out into the working tree), "after" against the branch; both write
 * <mode>-*.png, <mode>-proof.{txt,json} and phone/desktop videos. The after run also compares the non-forced-colors
 * focus/highlight crops pixel for pixel with the before run (sha256 of the PNG crops).
 *
 * Fixtures are fictional: a fresh onboarding user per mode (qa-fix-a11y-phone-<mode>-*@example.test) and one shell
 * user (qa-fix-a11y-phone-shell-*@example.test, workspace "QA Fix a11y phone") created by the before run and reused
 * by the after run so the crops show the same data. Every QA workspace's projects are deleted at the end of "after".
 * One browser, closed in `finally`.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { signIn, watch } from './qa-shoot.mjs';

const MODE = process.env.MODE === 'before' ? 'before' : 'after';
const BASE = process.env.BASE_URL ?? 'http://localhost:4600';
const SERVER = process.env.SERVER_URL ?? 'http://127.0.0.1:4601';
const OUT = path.resolve(process.env.OUT ?? '.');
const AXE = await readFile(process.env.AXE ?? 'axe.min.js', 'utf8');
/** Session of the fictional shell user; keep it outside the captures folder (it holds a cookie). */
const SHELL_STATE = path.resolve(process.env.SHELL_STATE ?? '.qa-a11y-shell.json');
const RUN = Date.now().toString(36);
const H = { Origin: BASE };
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const INVITEE = 'qa-fix-a11y-phone-invitee@example.test';

await mkdir(OUT, { recursive: true });
const log = [];
const results = { mode: MODE, checks: {}, axe: {}, crops: {} };
function note(key, value) {
  results[key] = value;
  const line = `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
  log.push(line);
  console.log(line);
}
/** In "before" a check documents the bug (expected to fail); in "after" a failure fails the run. */
function check(name, ok, detail) {
  results.checks[name] = { ok, detail };
  const line = `${ok ? 'PASS' : MODE === 'before' ? 'BUG ' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`;
  log.push(line);
  console.log(line);
  if (!ok && MODE === 'after') results.failed = (results.failed ?? 0) + 1;
}
async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    check(`${name} (ran without error)`, false, String(error?.message ?? error).slice(0, 400));
  }
}

async function settle(page, ms = 700) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await page
    .waitForFunction(() => document.querySelectorAll('[data-slot=skeleton]').length === 0, undefined, { timeout: 15_000 })
    .catch(() => undefined);
  await page.waitForTimeout(ms);
}
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, `${MODE}-${name}.png`), ...opts });

async function axe(page, name, include) {
  await page.addScriptTag({ content: AXE });
  const res = await page.evaluate(
    async ({ include }) =>
      window.axe.run(include ? { include: [include] } : document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      }),
    { include },
  );
  const violations = res.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    sample: v.nodes.slice(0, 2).map((n) => n.target.join(' ')),
  }));
  results.axe[name] = violations;
  const line = `axe ${name}: ${violations.length ? violations.map((v) => `${v.id}(${v.nodes})`).join(', ') : '0'}`;
  log.push(line);
  console.log(line);
}

/** The focused element, as a screen reader would name it. */
const focused = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { tag: 'BODY' };
    return {
      tag: el.tagName,
      role: el.getAttribute('role'),
      name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 60),
      checked: el.getAttribute('aria-checked'),
      selected: el.getAttribute('aria-selected'),
    };
  });

/** In forced colors: the focused element's outline and every other rendered element that computes one (#70's sweep). */
const outlines = (page, scope) =>
  page.evaluate((scope) => {
    const describe = (el) =>
      `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}${el.getAttribute('data-selected') === 'true' ? '[selected]' : ''} ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}`;
    const root = scope ? document.querySelector(scope) : document.body;
    const active = document.activeElement;
    const s = active ? getComputedStyle(active) : null;
    const others = [...(root?.querySelectorAll('*') ?? [])].filter(
      (el) => el !== active && el.getClientRects().length > 0 && getComputedStyle(el).outlineStyle !== 'none',
    );
    return {
      focused: s ? { el: describe(active), style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset } : null,
      unfocusedOutlined: others.length,
      outlined: others.slice(0, 12).map(describe),
    };
  }, scope);

const visibleFocusOutline = (o) => Boolean(o?.focused) && o.focused.style !== 'none' && Number.parseFloat(o.focused.width) >= 2;

async function crop(page, name, locator, pad = 12) {
  const box = await locator.boundingBox();
  if (!box) return;
  const vp = page.viewportSize();
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const clip = {
    x,
    y,
    width: Math.min(vp.width - x, Math.ceil(box.width + 2 * pad)),
    height: Math.min(vp.height - y, Math.ceil(box.height + 2 * pad)),
  };
  const buf = await page.screenshot({ clip, path: path.join(OUT, `${MODE}-crop-${name}.png`), animations: 'disabled', caret: 'hide' });
  results.crops[name] = createHash('sha256').update(buf).digest('hex');
}

/** Keyboard modality, so script focus() matches :focus-visible like a real Tab. */
async function keyboardFocus(page, locator) {
  await page.keyboard.press('Shift');
  await locator.focus();
  await page.waitForTimeout(450); // Button has transition-all: measure the settled outline
}

const json = async (res) => {
  if (!res.ok()) throw new Error(`${res.url()} → ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
};

function events(prefix, n) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    id: `qa-a11y-phone-${prefix}-${RUN}-${i}`,
    action: ['booking.created', 'guest.updated', 'room.rate.changed'][i % 3],
    occurredAt: new Date(now - i * 20_000).toISOString(),
    outcome: i % 7 === 0 ? 'failure' : 'success',
    description: `QA fixture event ${i}`,
    actor: { type: 'user', id: `usr_qa_${i % 3}`, name: ['Rowan Fixture', 'Iris Example', 'Noor Sample'][i % 3] },
    tenant: { id: `tn_qa_${i % 2}`, name: `QA Tenant ${i % 2}` },
    targets: [{ type: 'booking', id: `bk_qa_${i}`, name: `QA Booking ${i}` }],
  }));
}

const browser = await chromium.launch();
try {
  /* ================= Phone (390, dark, keyboard): login, onboarding, sheet ================= */
  {
    const email = `qa-fix-a11y-phone-${MODE}-${RUN}@example.test`;
    const ctx = await browser.newContext({
      viewport: PHONE,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      colorScheme: 'dark',
      recordVideo: { dir: OUT, size: PHONE },
    });
    const page = await ctx.newPage();
    const problems = watch(page);
    const video = page.video();

    /* PHONE-07: Tab past the empty email, come back, type a valid one, Enter once. */
    await step('login', async () => {
      await page.goto(`${BASE}/login`);
      await settle(page);
      const field = page.getByLabel('Work email');
      await field.focus();
      await page.keyboard.press('Tab'); // blur while empty
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.type(email, { delay: 15 });
      const sentAt = Date.now() - 2000;
      await page.keyboard.press('Enter');
      const reached = await page
        .waitForURL((u) => u.pathname.startsWith('/login/verify'), { timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      const error = await page
        .locator('#email-error')
        .textContent()
        .catch(() => null);
      if (!reached) await shot(page, 'login-stale-error-phone-dark');
      check('PHONE-07 first Enter sends the code after a blur error', reached, { url: new URL(page.url()).pathname, error });
      if (!reached) await page.keyboard.press('Enter'); // the documented workaround, so the run can continue
      await page.waitForURL((u) => u.pathname.startsWith('/login/verify'), { timeout: 15_000 });
      const { latestOtp } = await import('./qa-shoot.mjs');
      const code = await latestOtp(email, sentAt);
      await page.getByRole('textbox', { name: 'One-time code' }).focus();
      await page.keyboard.type(code, { delay: 50 });
      await page.waitForURL((u) => u.pathname.startsWith('/onboarding'), { timeout: 30_000 });
      await settle(page);
    });

    /* PHONE-12: the stepper as a screen reader reads it. */
    await step('stepper', async () => {
      const tree = await page.getByRole('list', { name: 'Setup progress' }).ariaSnapshot();
      note('stepper aria (profile step)', tree);
      const items = await page.evaluate(() =>
        [...document.querySelectorAll('ol[aria-label="Setup progress"] > li')].map((li) => ({
          current: li.getAttribute('aria-current'),
          text: li.innerText.replace(/\s+/g, ' ').trim(),
        })),
      );
      check('PHONE-12 every step label is in the accessibility tree at 390', /You[\s\S]*Workspace[\s\S]*Project[\s\S]*First event/.test(tree), tree);
      check(
        'PHONE-12 aria-current="step" is on the list item',
        items.some((i) => i.current === 'step'),
        items,
      );
      await shot(page, 'onboarding-profile-phone-dark');
      await page.keyboard.type('Rowan Fixture', { delay: 10 });
      await page.keyboard.press('Enter');
      await page.waitForURL((u) => u.pathname === '/onboarding' || u.pathname === '/onboarding/', { timeout: 15_000 });
      await settle(page);
      const tree2 = await page.getByRole('list', { name: 'Setup progress' }).ariaSnapshot();
      note('stepper aria (workspace step)', tree2);
      check('PHONE-12 done steps say "completed"', /completed/.test(tree2), tree2);
      await shot(page, 'onboarding-workspace-phone-dark');
      await page.getByLabel('Workspace name').fill(`QA Fix a11y phone ${MODE}`);
      await page.keyboard.press('Enter');
      await page.waitForURL((u) => u.pathname.startsWith('/onboarding/project'), { timeout: 15_000 });
      await settle(page);
    });

    /* PHONE-08: retention is one radiogroup, one Tab stop, arrow keys. */
    let firstEventPath = null;
    await step('retention', async () => {
      await page.getByLabel('Project name').fill('QA Phone App');
      const groups = await page.getByRole('radiogroup').count();
      const radios = await page.getByRole('radio').count();
      check('PHONE-08 retention is exposed by exactly one radiogroup', groups === 1, { radiogroups: groups, radios });
      // Tab from the description into the group, then arrows.
      await page.getByLabel(/Description/).focus();
      const stops = [];
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('Tab');
        const f = await focused(page);
        stops.push(f.role === 'radio' ? `radio:${f.name}` : `${f.tag}:${f.name}`);
        if (f.name.startsWith('Create project')) break;
      }
      const radioStops = stops.filter((s) => s.startsWith('radio:')).length;
      check('PHONE-08 the retention group is one Tab stop', radioStops === 1, stops);
      const radio = page.getByRole('radio', { checked: true }).last();
      await keyboardFocus(page, radio);
      const before = await focused(page);
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(250);
      const after = await focused(page);
      check('PHONE-08 ArrowRight moves the retention selection', after.role === 'radio' && after.name !== before.name && after.checked === 'true', {
        before,
        after,
      });
      await shot(page, 'onboarding-retention-focus-phone-dark');
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(450); // Button has transition-all: let the outline finish animating
      await page.getByRole('button', { name: /Create project/ }).press('Enter');
      await page.waitForURL((u) => u.pathname.startsWith('/onboarding/first-event'), { timeout: 20_000 });
      firstEventPath = new URL(page.url()).pathname;
      await settle(page, 1200);
    });

    /* PHONE-13: focus lands on the heading; the key row wraps. */
    await step('first-event', async () => {
      const f = await focused(page);
      check('PHONE-13 after "Create project" focus is on the h1, not BODY', f.tag === 'H1', f);
      const keyName = await page.evaluate(() => {
        const li = document.querySelector('ul.divide-y > li');
        const name = li?.querySelectorAll('span')[0];
        return name ? { text: name.textContent, truncated: name.scrollWidth > name.clientWidth + 1 } : null;
      });
      check('PHONE-13 the key name is not truncated at 390', keyName != null && !keyName.truncated, keyName);
      await shot(page, 'first-event-phone-dark');
      /* PHONE-08: snippet tabs. */
      const tab = page.getByRole('tab', { name: 'curl' });
      await keyboardFocus(page, tab);
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(250);
      const t = await focused(page);
      const tablist = await page.getByRole('tablist').first().ariaSnapshot();
      check(
        'PHONE-08 ArrowRight moves to the next snippet tab and selects it',
        t.role === 'tab' && t.name === 'TypeScript SDK' && t.selected === 'true',
        { focused: t, tablist },
      );
      await shot(page, 'snippet-tabs-focus-phone-dark');
      await axe(page, 'first-event phone-dark');
    });

    /* PHONE-09: the mobile sidebar sheet — name, description, one Escape after tabbing. */
    await step('sheet', async () => {
      const projectId = firstEventPath?.split('/').pop();
      await page.goto(`${BASE}/p/${projectId}`);
      await settle(page, 1200);
      await page.getByRole('button', { name: 'Toggle Sidebar' }).first().press('Enter');
      const sheet = page.locator('[data-mobile="true"]');
      await sheet.waitFor();
      await page.waitForTimeout(400);
      const named = await page.evaluate(() => {
        const d = document.querySelector('[data-mobile="true"]');
        const title = d?.getAttribute('aria-labelledby');
        const desc = d?.getAttribute('aria-describedby');
        return {
          name: title ? document.getElementById(title)?.textContent : null,
          description: desc ? document.getElementById(desc)?.textContent : null,
        };
      });
      check(
        'PHONE-09 the sheet is named "Navigation" with a meaningful description',
        named.name === 'Navigation' && /QA Fix a11y phone/.test(named.description ?? ''),
        named,
      );
      for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
      await page.waitForTimeout(200);
      await shot(page, 'sidebar-sheet-after-tabs-phone-dark');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      const open = await sheet.isVisible().catch(() => false);
      check('PHONE-09 one Escape closes the sheet after tabbing through it', !open, { stillOpen: open });
      if (open) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
      }
      await shot(page, 'sidebar-sheet-after-one-escape-phone-dark');
    });

    // Fixture cleanup: delete this onboarding user's QA project.
    await step('phone cleanup', async () => {
      const projectId = firstEventPath?.split('/').pop();
      if (!projectId) return;
      const project = await json(await ctx.request.get(`${BASE}/api/projects/${projectId}`, { headers: H }));
      const slug = project.project?.slug ?? project.slug;
      const res = await ctx.request.delete(`${BASE}/api/projects/${projectId}?confirm=${encodeURIComponent(slug)}`, { headers: H });
      note('cleanup: onboarding QA project deleted', res.status());
    });
    note('phone console problems', [...new Set(problems)]);
    await ctx.close();
    const v = await video?.path();
    if (v) await rename(v, path.join(OUT, `${MODE}-keyboard-phone-390-dark.webm`));
  }

  /* ================= Shell fixture (shared by before/after) ================= */
  let shell;
  if (MODE === 'before') {
    const ctx = await browser.newContext({ viewport: DESKTOP });
    const page = await ctx.newPage();
    const email = `qa-fix-a11y-phone-shell-${RUN}@example.test`;
    await signIn(page, email);
    const api = ctx.request;
    await json(await api.post(`${BASE}/api/auth/update-user`, { headers: H, data: { name: 'Rowan Fixture' } }));
    const org = await json(
      await api.post(`${BASE}/api/auth/organization/create`, { headers: H, data: { name: 'QA Fix a11y phone', slug: `qa-fix-a11y-phone-${RUN}` } }),
    );
    await json(await api.post(`${BASE}/api/auth/organization/set-active`, { headers: H, data: { organizationId: org.id } }));
    const created = await json(await api.post(`${BASE}/api/projects`, { headers: H, data: { name: 'QA Phone Shell' } }));
    await json(await api.patch(`${BASE}/api/projects/${created.project.id}`, { headers: H, data: { retentionReviewed: true } }));
    await json(await api.post(`${BASE}/api/auth/organization/invite-member`, { headers: H, data: { email: INVITEE, role: 'member' } }));
    const res = await fetch(`${SERVER}/v1/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.ingestKey.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(events('shell', 60)),
    });
    if (res.status !== 202) throw new Error(`ingest ${res.status} ${await res.text()}`);
    await ctx.storageState({ path: SHELL_STATE });
    shell = { projectId: created.project.id, slug: created.project.slug };
    await writeFile(`${SHELL_STATE}.meta.json`, JSON.stringify(shell));
    await ctx.close();
    note('shell fixture', { workspace: 'QA Fix a11y phone', project: 'QA Phone Shell', events: 60, invitation: 'pending (fictional)' });
  } else {
    shell = JSON.parse(await readFile(`${SHELL_STATE}.meta.json`, 'utf8'));
  }

  /* ================= Desktop + 390: forced colors and crops ================= */
  for (const [label, viewport, extra] of [
    ['desktop', DESKTOP, {}],
    ['phone', PHONE, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
  ]) {
    for (const scheme of ['light', 'dark']) {
      const recording = label === 'desktop' && scheme === 'light';
      const ctx = await browser.newContext({
        viewport,
        colorScheme: scheme,
        storageState: SHELL_STATE,
        ...extra,
        ...(recording ? { recordVideo: { dir: OUT, size: viewport } } : {}),
      });
      const page = await ctx.newPage();
      const problems = watch(page);
      const tag = `${label}-${scheme}`;
      const fcRuns = scheme === 'light'; // forced colors ignore the author scheme; once per viewport is enough

      /* Settings → API keys: Button focus, Create key dialog radios. */
      await step(`keys ${tag}`, async () => {
        await page.goto(`${BASE}/p/${shell.projectId}/settings/keys`);
        await settle(page);
        const create = page.getByRole('button', { name: /^Create key$/ }).first();
        await keyboardFocus(page, create);
        await crop(page, `button-focus-${tag}`, create);
        if (fcRuns) {
          await page.emulateMedia({ forcedColors: 'active' });
          await page.waitForTimeout(450); // Button has transition-all: let the outline finish animating
          const o = await outlines(page, 'main');
          check(`#85 forced colors (${label}): focused Button (default) paints an outline ≥ 2px`, visibleFocusOutline(o), o.focused);
          check(`#85 forced colors (${label}): no unfocused control on Settings → Keys is outlined`, o.unfocusedOutlined === 0, o);
          await shot(page, `forced-colors-button-focus-${label}`);
          await page.emulateMedia({ forcedColors: 'none' });
        }
        await create.press('Enter');
        const dialog = page.getByRole('dialog');
        await dialog.waitFor();
        await page.waitForTimeout(300);
        const group = dialog.getByRole('radiogroup');
        const groupCount = await group.count();
        const groupName = groupCount ? await group.first().getAttribute('aria-labelledby') : null;
        const ingest = dialog.getByRole('radio', { name: /Ingest/ });
        await keyboardFocus(page, ingest);
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(250);
        const f = await focused(page);
        check(`PHONE-08 key kind: ArrowDown selects "Read" (${tag})`, f.role === 'radio' && /Read/.test(f.name) && f.checked === 'true', {
          focused: f,
          radiogroups: groupCount,
          labelledBy: groupName,
        });
        await shot(page, `create-key-dialog-radio-focus-${tag}`);
        if (label === 'desktop') await axe(page, `create-key dialog ${tag}`, '[role="dialog"]');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      });

      /* Settings → Retention: one radiogroup. */
      await step(`retention ${tag}`, async () => {
        await page.goto(`${BASE}/p/${shell.projectId}/settings/retention`);
        await settle(page);
        const groups = await page.getByRole('radiogroup').count();
        check(`PHONE-08 settings retention: one radiogroup (${tag})`, groups === 1, { radiogroups: groups });
        const radio = page.getByRole('radio', { checked: true }).first();
        await keyboardFocus(page, radio);
        await shot(page, `settings-retention-focus-${tag}`);
        if (label === 'desktop') await axe(page, `settings-retention ${tag}`);
      });

      /* Settings → Members: the invitation's Actions dropdown (ghost icon Button + menu items). */
      await step(`members ${tag}`, async () => {
        await page.goto(`${BASE}/p/${shell.projectId}/settings/members`);
        await settle(page);
        const trigger = page.getByRole('button', { name: `Actions for ${INVITEE}` });
        await keyboardFocus(page, trigger);
        if (fcRuns) {
          await page.emulateMedia({ forcedColors: 'active' });
          await page.waitForTimeout(450); // Button has transition-all: let the outline finish animating
          const o = await outlines(page, 'main');
          check(`#85 forced colors (${label}): focused ghost icon Button paints an outline ≥ 2px`, visibleFocusOutline(o), o.focused);
          await page.emulateMedia({ forcedColors: 'none' });
        }
        await trigger.press('Enter');
        const menu = page.getByRole('menu');
        await menu.waitFor();
        await page.waitForTimeout(300);
        await crop(page, `members-menu-highlight-${tag}`, menu);
        if (fcRuns) {
          await page.emulateMedia({ forcedColors: 'active' });
          await page.waitForTimeout(450); // Button has transition-all: let the outline finish animating
          const o = await outlines(page, '[role="menu"]');
          check(
            `#85 forced colors (${label}): Settings menu — only the highlighted item is outlined`,
            visibleFocusOutline(o) && o.unfocusedOutlined === 0,
            o,
          );
          await shot(page, `forced-colors-settings-menu-${label}`);
          await page.emulateMedia({ forcedColors: 'none' });
        }
        if (label === 'desktop') await axe(page, `members ${tag}`);
        await page.keyboard.press('Escape');
      });

      /* Explorer: toolbar buttons, Columns checkbox menu, event sheet Previous/Next, command palette. */
      await step(`explorer ${tag}`, async () => {
        await page.goto(`${BASE}/p/${shell.projectId}/events?range=24h`);
        await settle(page, 1200);
        if (fcRuns) {
          await page.emulateMedia({ forcedColors: 'active' });
          const toolbar = [];
          // The first eight enabled shared Buttons on the explorer (toolbar, range, chart controls), whatever their variant.
          const buttons = page.locator('main [data-slot="button"]:visible:not([disabled])');
          const n = Math.min(8, await buttons.count());
          for (let i = 0; i < n; i++) {
            await keyboardFocus(page, buttons.nth(i));
            const o = await outlines(page, 'main');
            toolbar.push({ ...o.focused, unfocusedOutlined: o.unfocusedOutlined, outlined: o.outlined.slice(0, 3) });
          }
          check(
            `#85 forced colors (${label}): explorer toolbar buttons paint an outline when focused, nothing else is outlined`,
            toolbar.length > 0 && toolbar.every((t) => t.style !== 'none' && Number.parseFloat(t.width) >= 2 && t.unfocusedOutlined === 0),
            toolbar,
          );
          await shot(page, `forced-colors-explorer-toolbar-${label}`);
          await page.emulateMedia({ forcedColors: 'none' });
        }
        const columns = page.getByRole('button', { name: 'Choose columns' });
        if (await columns.isVisible().catch(() => false)) {
          await columns.press('Enter');
          const menu = page.getByRole('menu');
          await menu.waitFor();
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(250);
          await crop(page, `columns-menu-highlight-${tag}`, menu);
          if (fcRuns) {
            await page.emulateMedia({ forcedColors: 'active' });
            await page.waitForTimeout(450); // Button has transition-all: let the outline finish animating
            const o = await outlines(page, '[role="menu"]');
            check(
              `#85 forced colors (${label}): checkbox menu — only the highlighted item is outlined`,
              visibleFocusOutline(o) && o.unfocusedOutlined === 0,
              o,
            );
            await shot(page, `forced-colors-columns-menu-${label}`);
            await page.emulateMedia({ forcedColors: 'none' });
          }
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
        }
        // Event sheet: open the first row from the grid, then Tab to Next event.
        await keyboardFocus(page, page.locator('[role="row"][tabindex="0"]').first());
        await page.keyboard.press('Enter');
        const sheet = page.getByRole('dialog');
        await sheet.waitFor();
        await page.waitForTimeout(500);
        const next = sheet.getByRole('button', { name: 'Next event' });
        await keyboardFocus(page, next);
        await crop(page, `sheet-next-focus-${tag}`, next, 16);
        if (fcRuns) {
          await page.emulateMedia({ forcedColors: 'active' });
          await page.waitForTimeout(450); // Button has transition-all: let the outline finish animating
          const o = await outlines(page, '[role="dialog"]');
          check(`#85 forced colors (${label}): event sheet "Next event" paints an outline ≥ 2px`, visibleFocusOutline(o), o.focused);
          check(`#85 forced colors (${label}): nothing else in the event sheet is outlined`, o.unfocusedOutlined === 0, o);
          await shot(page, `forced-colors-event-sheet-next-${label}`);
          const prev = sheet.getByRole('button', { name: 'Previous event' });
          if (await prev.isEnabled()) {
            await keyboardFocus(page, prev);
            const p = await outlines(page, '[role="dialog"]');
            check(`#85 forced colors (${label}): event sheet "Previous event" paints an outline ≥ 2px`, visibleFocusOutline(p), p.focused);
          }
          await page.emulateMedia({ forcedColors: 'none' });
        }
        if (label === 'desktop') await axe(page, `event-sheet ${tag}`, '[role="dialog"]');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        if (label === 'desktop') await axe(page, `explorer ${tag}`);
        // Command palette.
        await page.keyboard.press('Control+k');
        const palette = page.getByRole('dialog');
        await palette.waitFor();
        await page.waitForTimeout(300);
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(200);
        await crop(page, `palette-highlight-${tag}`, palette);
        if (fcRuns) {
          await page.emulateMedia({ forcedColors: 'active' });
          await page.waitForTimeout(450); // Button has transition-all: let the outline finish animating
          const o = await outlines(page, '[role="dialog"]');
          const onlySelected = o.outlined.length === 1 && o.outlined[0].includes('[selected]');
          check(`#85 forced colors (${label}): command palette — the input and the active item only`, visibleFocusOutline(o) && onlySelected, o);
          await shot(page, `forced-colors-palette-${label}`);
          await page.emulateMedia({ forcedColors: 'none' });
        }
        await page.keyboard.press('Escape');
      });

      note(`console problems ${tag}`, [...new Set(problems)]);
      const video = recording ? page.video() : null;
      await ctx.close();
      const v = await video?.path();
      if (v) await rename(v, path.join(OUT, `${MODE}-forced-colors-keyboard-desktop.webm`));
    }
  }

  /* ================= Outside forced colors: pixel-identical crops ================= */
  if (MODE === 'after') {
    const before = JSON.parse(await readFile(path.join(OUT, 'before-proof.json'), 'utf8')).crops ?? {};
    const diff = Object.keys(results.crops).map((k) => ({ crop: k, identical: before[k] === results.crops[k] }));
    check(
      '#85 outside forced colors: focus rings and menu/palette highlights are pixel-identical to master',
      diff.every((d) => d.identical),
      diff,
    );
  }
} finally {
  if (MODE === 'after') {
    // Delete every QA project the two runs created (onboarding users' projects and the shell project).
    for (const file of [SHELL_STATE]) {
      const ctx = await browser.newContext({ storageState: file }).catch(() => null);
      if (!ctx) continue;
      const meta = JSON.parse(await readFile(`${SHELL_STATE}.meta.json`, 'utf8').catch(() => '{}'));
      if (meta.projectId) {
        const res = await ctx.request.delete(`${BASE}/api/projects/${meta.projectId}?confirm=${encodeURIComponent(meta.slug)}`, { headers: H });
        note('cleanup: shell QA project deleted', res.status());
      }
      await ctx.close();
    }
  }
  await browser.close();
  await writeFile(path.join(OUT, `${MODE}-proof.txt`), `${log.join('\n')}\n`);
  await writeFile(path.join(OUT, `${MODE}-proof.json`), `${JSON.stringify(results, null, 2)}\n`);
}
process.exit(results.failed ? 1 : 0);
