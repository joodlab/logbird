import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { prerenderPaths } from '../src/lib/site-map.ts';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:4620';
const output = resolve(process.env.OUT_DIR ?? '.tmp/captures');
const paths = process.env.PATHS ? process.env.PATHS.split(',').map((path) => path.trim()) : prerenderPaths;
await mkdir(output, { recursive: true });
// Playwright's bundled Chromium only (shared-machine rule: never the installed Chrome or a personal profile).
const browser = await chromium.launch();
const failures = [];
try {
  for (const path of paths) {
    const slug = path === '/' ? 'home' : path.slice(1).replaceAll('/', '-');
    for (const [device, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } })) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport,
          colorScheme: theme,
          // Stills show the settled page: full-page capture restarts CSS entrance animations.
          reducedMotion: process.env.VIDEO === '1' ? 'no-preference' : 'reduce',
          ...(process.env.VIDEO === '1' ? { recordVideo: { dir: output, size: viewport } } : {}),
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => failures.push(`${path}: ${error.message}`));
        page.on('console', (message) => {
          if (message.type() === 'error') {
            failures.push(`${path}: ${message.text()}`);
          }
        });
        page.on('requestfailed', (request) => failures.push(`${path}: ${request.url()} ${request.failure()?.errorText}`));
        page.on('response', (response) => {
          if (response.status() >= 400) {
            failures.push(`${path}: HTTP ${response.status()} ${response.url()}`);
          }
        });
        await page.addInitScript((value) => localStorage.setItem('logbird.site.theme', value), theme);
        const video = page.video();
        try {
          await page.goto(new URL(path, base).href, { waitUntil: 'networkidle' });
          // Load lazy images and let entrance animations finish before a full-page still.
          await page.evaluate(async () => {
            for (const image of document.images) {
              image.loading = 'eager';
            }
            for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight / 2) {
              scrollTo(0, y);
              await new Promise((done) => setTimeout(done, 60));
            }
            scrollTo(0, 0);
            // Hidden theme variants never load; wait only for visible images, and never longer than 5 s.
            const visible = [...document.images].filter((image) => image.offsetParent !== null);
            const decoded = visible.map((image) =>
              image.complete && image.naturalWidth > 0
                ? image.decode().catch(() => undefined)
                : new Promise((done) => {
                    image.addEventListener(
                      'load',
                      () =>
                        image
                          .decode()
                          .catch(() => undefined)
                          .then(done),
                      { once: true },
                    );
                    image.addEventListener('error', done, { once: true });
                  }),
            );
            await Promise.race([Promise.all(decoded), new Promise((done) => setTimeout(done, 10_000))]);
          });
          await page.waitForTimeout(2000);
          await page.screenshot({ path: resolve(output, `${slug}-${device}-${theme}.png`), fullPage: true });
          if (process.env.VIDEO === '1') {
            await page.evaluate(async () => {
              const distance = document.documentElement.scrollHeight - innerHeight;
              const start = performance.now();
              await new Promise((done) => {
                const frame = (now) => {
                  const progress = Math.min((now - start) / 8000, 1);
                  const fraction = (1 - Math.cos(progress * Math.PI * 2)) / 2;
                  scrollTo(0, distance * fraction);
                  if (progress < 1) {
                    requestAnimationFrame(frame);
                  } else {
                    done();
                  }
                };
                requestAnimationFrame(frame);
              });
            });
          }
        } finally {
          await context.close();
        }
        if (video) {
          await video.saveAs(resolve(output, `${slug}-${device}-${theme}.webm`));
          await video.delete();
        }
      }
    }
  }
  if (failures.length) {
    throw new Error([...new Set(failures)].join('\n'));
  }
} finally {
  await browser.close();
}
