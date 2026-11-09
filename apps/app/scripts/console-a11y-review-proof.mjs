/**
 * Follow-up proof for the review of PR #108, against a REAL local stack (app :4600, server :4601, worker):
 *  - axe (wcag2a/aa, wcag21a/aa, wcag22aa) on Settings → Retention, light and dark (L2);
 *  - the stepper's spoken text has no stray separator ("Step 1 of 4: You, completed");
 *  - key-kind radios are named "Ingest — …" / "Read — …";
 *  - clicking a hidden retention shortcut card does not move focus onto it, and still sets the value;
 *  - forced colors: a focused retention chip radio paints an outline ≥ 2px.
 *
 *   AXE=/path/to/axe.min.js OUT=../../output/qa/2026-11-08-console-a11y node scripts/console-a11y-review-proof.mjs
 *
 * Fixture: fictional `qa-fix-a11y-phone-review-*@example.test`, workspace "QA Fix a11y phone review", project "QA Phone
 * Review" (deleted at the end). One browser, closed in `finally`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { signIn, watch } from './qa-shoot.mjs';

const BASE = process.env.BASE_URL ?? 'http://localhost:4600';
const OUT = path.resolve(process.env.OUT ?? '.');
const AXE = await readFile(process.env.AXE ?? 'axe.min.js', 'utf8');
const RUN = Date.now().toString(36);
const H = { Origin: BASE };

const log = [];
const results = { checks: {}, axe: {} };
let failed = 0;
function check(name, ok, detail) {
  results.checks[name] = { ok, detail };
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`;
  log.push(line);
  console.log(line);
  if (!ok) failed++;
}
function note(line) {
  log.push(line);
  console.log(line);
}

async function settle(page, ms = 900) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(ms);
}
async function axe(page, name) {
  await page.addScriptTag({ content: AXE });
  const res = await page.evaluate(() =>
    window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }),
  );
  const violations = res.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    sample: v.nodes.slice(0, 2).map((n) => n.target.join(' ')),
  }));
  results.axe[name] = violations;
  note(`axe ${name}: ${violations.length ? violations.map((v) => `${v.id}(${v.nodes})`).join(', ') : '0'}`);
  return violations;
}
const json = async (res) => {
  if (!res.ok()) throw new Error(`${res.url()} → ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
};

const browser = await chromium.launch();
let api;
let project;
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  const problems = watch(page);
  api = ctx.request;
  await signIn(page, `qa-fix-a11y-phone-review-${RUN}@example.test`);
  await json(await api.post(`${BASE}/api/auth/update-user`, { headers: H, data: { name: 'Rowan Fixture' } }));
  const org = await json(
    await api.post(`${BASE}/api/auth/organization/create`, {
      headers: H,
      data: { name: 'QA Fix a11y phone review', slug: `qa-fix-a11y-phone-review-${RUN}` },
    }),
  );
  await json(await api.post(`${BASE}/api/auth/organization/set-active`, { headers: H, data: { organizationId: org.id } }));

  /* Stepper on the project step: "You" and "Workspace" are done. */
  await page.goto(`${BASE}/onboarding/project`);
  await settle(page);
  const tree = await page.getByRole('list', { name: 'Setup progress' }).ariaSnapshot();
  note(`stepper aria (project step):\n${tree}`);
  check(
    'stepper: one spoken string per step, no stray separator',
    tree.includes('Step 1 of 4: You, completed') &&
      tree.includes('Step 2 of 4: Workspace, completed') &&
      tree.includes('Step 3 of 4: Project') &&
      !/ ,/.test(tree),
    tree,
  );

  project = (await json(await api.post(`${BASE}/api/projects`, { headers: H, data: { name: 'QA Phone Review' } }))).project;

  /* Key-kind radio names. */
  await page.goto(`${BASE}/p/${project.id}/settings/keys`);
  await settle(page);
  await page
    .getByRole('button', { name: /^Create key$/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await page.waitForTimeout(300);
  const names = await dialog.getByRole('radio').evaluateAll((els) => els.map((e) => e.textContent?.replace(/\s+/g, ' ').trim()));
  const radios = await dialog.getByRole('radiogroup').ariaSnapshot();
  check('key kind: radios are named "Ingest — …" and "Read — …"', /^Ingest — \S/.test(names[0] ?? '') && /^Read — \S/.test(names[1] ?? ''), radios);
  await page.keyboard.press('Escape');

  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`${BASE}/p/${project.id}/settings/retention`);
    await settle(page);
    const v = await axe(page, `settings-retention desktop-${scheme}`);
    check(`L2 axe Settings → Retention desktop-${scheme}: 0 violations`, v.length === 0, v);
    await page.screenshot({ path: path.join(OUT, `after-review-settings-retention-desktop-${scheme}.png`) });
  }

  /* Clicking a shortcut card sets the value without focusing the aria-hidden card. */
  await page.emulateMedia({ colorScheme: 'light' });
  const card = page.locator('[data-testid="retention-shortcuts"] button').first();
  await card.click();
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({
    focusInShortcuts: Boolean(document.activeElement?.closest('[data-testid="retention-shortcuts"]')),
    focused: document.activeElement?.tagName,
    checked: document.querySelector('[role="radio"][aria-checked="true"]')?.textContent,
  }));
  check('shortcut card click: value set, focus not on the hidden card', !after.focusInShortcuts && /^30 days/.test(after.checked ?? ''), after);

  /* Forced colors: focused chip radio. */
  const chip = page.getByRole('radio', { checked: true });
  await page.keyboard.press('Shift');
  await chip.focus();
  await page.emulateMedia({ forcedColors: 'active' });
  await page.waitForTimeout(450);
  const o = await chip.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset };
  });
  check('forced colors: focused retention chip radio paints an outline ≥ 2px', o.style !== 'none' && Number.parseFloat(o.width) >= 2, o);
  await page.screenshot({ path: path.join(OUT, 'after-review-forced-colors-retention-chip-desktop.png') });
  await page.emulateMedia({ forcedColors: 'none' });

  note(`console problems: ${JSON.stringify([...new Set(problems)])}`);
} finally {
  if (project && api) {
    const res = await api.delete(`${BASE}/api/projects/${project.id}?confirm=${encodeURIComponent(project.slug)}`, { headers: H }).catch(() => null);
    note(`cleanup: QA project "QA Phone Review" deleted: ${res?.status()}`);
  }
  await browser.close();
  await writeFile(path.join(OUT, 'after-review-proof.txt'), `${log.join('\n')}\n`);
  await writeFile(path.join(OUT, 'after-review-proof.json'), `${JSON.stringify(results, null, 2)}\n`);
}
process.exit(failed ? 1 : 0);
