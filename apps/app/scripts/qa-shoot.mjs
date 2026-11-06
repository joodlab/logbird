/**
 * QA helper: screenshot console pages against the real server and report console noise.
 *
 *   node scripts/qa-shoot.mjs login [email]                       # OTP via Mailpit → saves session state
 *   node scripts/qa-shoot.mjs shoot <outDir> <theme> <WxH> <path…>  # one PNG per path
 *
 * Every console warning/error, page error and failed /api request is printed, so "zero console
 * noise" can be checked page by page. STATE (env) overrides where the session is stored.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:4600';
const MAILPIT = process.env.MAILPIT_API ?? 'http://127.0.0.1:8025';
const STATE = process.env.STATE ?? path.resolve('.qa-state.json');

export async function latestOtp(email, after) {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=5`);
    const list = await res.json();
    const msg = (list.messages ?? []).find((m) => Date.parse(m.Created) >= after);
    if (msg) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)).json();
      const code = /\b(\d{6})\b/.exec(`${full.Text ?? ''}`)?.[1] ?? /\b(\d{6})\b/.exec(`${full.HTML ?? ''}`)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No OTP email for ${email} in Mailpit`);
}

export async function signIn(page, email) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Work email').fill(email);
  const sentAt = Date.now() - 2000;
  await page.getByRole('button', { name: /continue with email/i }).click();
  const otp = page.getByRole('textbox', { name: 'One-time code' });
  await otp.waitFor();
  const code = await latestOtp(email, sentAt);
  await otp.click();
  await page.keyboard.type(code, { delay: 60 });
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
}

export function watch(page, label = () => page.url()) {
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') problems.push(`[${m.type()}] ${label()} ${m.text().slice(0, 400)}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${label()} ${e.message}`));
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) problems.push(`[http ${r.status()}] ${r.request().method()} ${r.url().replace(BASE, '')}`);
  });
  return problems;
}

async function settle(page, ms = 1200) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  // Wait for skeletons to resolve.
  await page
    .waitForFunction(() => document.querySelectorAll('[data-slot=skeleton]').length === 0, undefined, { timeout: 15_000 })
    .catch(() => undefined);
  await page.waitForTimeout(ms);
}

// CLI only when run directly (capture-media.mjs imports the helpers above).
const direct = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
const [cmd, ...args] = direct ? process.argv.slice(2) : [];
if (cmd === 'login') {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const problems = watch(page);
  await signIn(page, args[0] ?? 'demo@logbird.local');
  await settle(page);
  console.log('signed in →', page.url());
  await ctx.storageState({ path: STATE });
  await browser.close();
  if (problems.length) console.log(problems.join('\n'));
} else if (cmd === 'shoot') {
  const [outDir, theme, size, ...paths] = args;
  const [width, height] = size.split('x').map(Number);
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme === 'dark' ? 'dark' : 'light',
    storageState: STATE,
    deviceScaleFactor: width < 600 ? 2 : 1,
  });
  const page = await ctx.newPage();
  const problems = watch(page);
  for (const p of paths) {
    const [url, name = url.replace(/[^\w]+/g, '_').slice(0, 60)] = p.split('|');
    const t0 = Date.now();
    await page.goto(`${BASE}${url}`);
    await settle(page);
    await page.screenshot({ path: path.join(outDir, `${theme}-${name}.png`), fullPage: process.env.FULL === '1' });
    console.log(`✓ ${name} ${Date.now() - t0}ms`);
  }
  await browser.close();
  console.log(problems.length ? `\nProblems:\n${[...new Set(problems)].join('\n')}` : '\nNo console warnings/errors.');
}
