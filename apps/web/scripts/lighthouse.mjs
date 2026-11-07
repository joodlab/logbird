/**
 * Lighthouse for every manifest page, mobile and desktop, median of RUNS (default 3). Lighthouse is fetched on demand
 * with npx (not a dependency of the repo) and drives Playwright's bundled Chromium only (shared-machine rule).
 *
 *   BASE_URL=http://127.0.0.1:4620 [PATHS=/,/contact] [RUNS=3] [OUT_DIR=.tmp/lighthouse] node --import tsx scripts/lighthouse.mjs [--no-fail]
 *
 * Serve the static build first (`pnpm serve:static`): it compresses like Cloudflare, which the Node preview doesn't.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { prerenderPaths } from '../src/lib/site-map.ts';

const LIGHTHOUSE = 'lighthouse@13.6.0';
const base = process.env.BASE_URL ?? 'http://127.0.0.1:4620';
const output = resolve(process.env.OUT_DIR ?? '.tmp/lighthouse');
const paths = process.env.PATHS ? process.env.PATHS.split(',').map((path) => path.trim()) : prerenderPaths;
const runs = Math.max(1, Number(process.env.RUNS ?? 3));
const categories = ['performance', 'accessibility', 'best-practices', 'seo'];
// noindex pages (404, unready pages, and every page while a release blocker is open) fail Lighthouse's is-crawlable
// audit by design; the release gate decides crawlability and has its own tests. So the pass mark applies to the SEO
// score without that one audit (`seo-content`), and the plain score is reported beside it.
const seoWithoutCrawlable = (lhr) => {
  const refs = lhr.categories.seo.auditRefs.filter((ref) => ref.weight > 0 && ref.id !== 'is-crawlable' && lhr.audits[ref.id]?.score !== null);
  const weight = refs.reduce((sum, ref) => sum + ref.weight, 0);
  return weight ? Math.round((refs.reduce((sum, ref) => sum + ref.weight * (lhr.audits[ref.id]?.score ?? 0), 0) / weight) * 100) : 0;
};
const chromePath = chromium.executablePath();
await mkdir(output, { recursive: true });

function audit(url, formFactor, file) {
  const args = [
    '-y',
    LIGHTHOUSE,
    url,
    '--quiet',
    '--output=json',
    `--output-path=${file}`,
    `--only-categories=${categories.join(',')}`,
    `--chrome-path=${chromePath}`,
    '--chrome-flags=--headless=new --disable-gpu',
    ...(formFactor === 'desktop' ? ['--preset=desktop'] : []),
  ];
  return new Promise((done, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? done() : reject(new Error(`lighthouse exited ${code} for ${url}`))));
  });
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rows = [];
for (const path of paths) {
  for (const formFactor of ['mobile', 'desktop']) {
    const slug = path === '/' ? 'home' : path.slice(1).replaceAll('/', '-');
    const reports = [];
    for (let run = 0; run < runs; run += 1) {
      const file = resolve(output, `${slug}-${formFactor}-run${run}.json`);
      await audit(new URL(path, base).href, formFactor, file);
      reports.push(JSON.parse(await readFile(file, 'utf8')));
      await rm(file);
    }
    const scores = (key) => reports.map((lhr) => Math.round((lhr.categories[key]?.score ?? 0) * 100));
    const row = {
      path,
      formFactor,
      ...Object.fromEntries(categories.map((key) => [key, median(scores(key))])),
      'seo-content': median(reports.map(seoWithoutCrawlable)),
      runs: scores('performance').join(' '),
    };
    rows.push(row);
    const representative = reports.find((lhr) => Math.round(lhr.categories.performance.score * 100) === row.performance) ?? reports[0];
    await writeFile(
      resolve(output, `${slug}-${formFactor}.json`),
      JSON.stringify({ ...row, fetchTime: representative.fetchTime, audits: representative.audits }, null, 2),
    );
    console.log(`${path} ${formFactor}: ${row.performance}/${row.accessibility}/${row['best-practices']}/${row.seo} (performance runs: ${row.runs})`);
  }
}
console.table(rows);
await writeFile(resolve(output, 'summary.json'), JSON.stringify(rows, null, 2));
if (!process.argv.includes('--no-fail') && rows.some((row) => categories.some((key) => (key === 'seo' ? row['seo-content'] : row[key]) < 95))) {
  process.exitCode = 1;
}
