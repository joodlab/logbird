/**
 * Real-mode smoke test: drives the console against the running apps/server (no fixtures).
 *
 *   pnpm --filter @trailmark/server dev        # :4601, shared local services
 *   pnpm --filter @trailmark/app dev           # :4600, real mode
 *   node apps/app/scripts/real-smoke.mjs [email]
 *
 * Signs in with email OTP (the code is read from Mailpit's API), then walks every main page,
 * failing on uncaught page errors or failed /api requests, and saves screenshots as real-*.png.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../../docs/media/ui-foundation');
const BASE = process.env.BASE_URL ?? 'http://localhost:4600';
const MAILPIT = process.env.MAILPIT_API ?? 'http://127.0.0.1:8025';
const EMAIL = process.argv[2] ?? 'demo@trailmark.local';
const SHOTS = process.env.SHOTS !== '0';

async function latestOtp(email, after) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=5`);
    const list = await res.json();
    const msg = (list.messages ?? []).find((m) => Date.parse(m.Created) >= after);
    if (msg) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)).json();
      const code = /\b(\d{6})\b/.exec(`${full.Text ?? ''} ${full.HTML ?? ''}`)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No OTP email for ${email} in Mailpit`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('response', (r) => {
  const url = r.url();
  if (url.includes('/api/') && r.status() >= 400 && r.status() !== 401)
    problems.push(`${r.status()} ${r.request().method()} ${url.replace(BASE, '')}`);
});

await mkdir(OUT, { recursive: true });
await page.goto(`${BASE}/login`);
await page.getByLabel('Work email').fill(EMAIL);
const sentAt = Date.now() - 2000;
await page.getByRole('button', { name: /continue with email/i }).click();
const otp = page.getByRole('textbox', { name: 'One-time code' });
await otp.waitFor();
const code = await latestOtp(EMAIL, sentAt);
await otp.click();
await page.keyboard.type(code, { delay: 40 });
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
await page.waitForTimeout(2500);
console.log('signed in →', page.url());

const projectPath = new URL(page.url()).pathname.match(/^\/p\/[^/]+/)?.[0];
if (!projectPath) {
  console.log('No project yet (onboarding):', page.url());
} else {
  const pages = [
    ['', 'overview'],
    ['/events?range=7d', 'explorer'],
    ['/actors', 'actors'],
    ['/tenants', 'tenants'],
    ['/workers', 'workers'],
    ['/records', 'records'],
    ['/views', 'views'],
    ['/fields?range=7d', 'fields'],
    ['/settings', 'settings'],
    ['/settings/retention', 'retention'],
    ['/settings/keys', 'keys'],
    ['/settings/members', 'members'],
    ['/settings/activity', 'activity'],
    ['/docs', 'docs'],
  ];
  for (const [suffix, name] of pages) {
    await page.goto(`${BASE}${projectPath}${suffix}`);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(1800);
    if (SHOTS) await page.screenshot({ path: path.join(OUT, `real-${name}.png`) });
    console.log('  ✓', name);
  }
  // Open the first event, then follow its actor and operation when present.
  await page.goto(`${BASE}${projectPath}/events?range=30d`);
  await page.waitForTimeout(2500);
  await page.locator('[role=row][data-index="0"]').click();
  await page.waitForTimeout(2000);
  if (SHOTS) await page.screenshot({ path: path.join(OUT, 'real-event-detail.png') });
  console.log('  ✓ event detail');
  const op = page.getByRole('button', { name: /view operation/i });
  if (await op.isVisible().catch(() => false)) {
    await op.click();
    await page.waitForTimeout(2500);
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'real-operation.png') });
    console.log('  ✓ operation');
  }
  const actor = await page.evaluate(() => document.querySelector('a[href*="/actors/"]')?.getAttribute('href'));
  if (actor) {
    await page.goto(`${BASE}${actor}`);
    await page.waitForTimeout(2500);
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'real-actor-profile.png') });
    console.log('  ✓ actor profile');
  }
}

await browser.close();
if (problems.length) {
  console.log('\nProblems:\n' + [...new Set(problems)].join('\n'));
  process.exitCode = 1;
} else {
  console.log('\nNo page errors and no failed API calls.');
}
