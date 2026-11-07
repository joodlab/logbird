import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { prerenderPaths } from '../src/lib/site-map.ts';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:4620';
const output = resolve(process.env.OUT_DIR ?? '.tmp/lighthouse');
const paths = process.env.PATHS ? process.env.PATHS.split(',').map((path) => path.trim()) : prerenderPaths;
await mkdir(output, { recursive: true });
const chrome = await launch({ chromeFlags: ['--headless=new', '--disable-gpu'], port: 0 });
const rows = [];
// Lighthouse's simulated throttling varies between runs; report the median of RUNS runs (Google's recommendation).
const noindex = new Set(['/blog/draft', '/404']);
const runs = Math.max(1, Number(process.env.RUNS ?? 3));
const categories = ['performance', 'accessibility', 'best-practices', 'seo'];
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
async function audit(path, formFactor) {
  const result = await lighthouse(
    new URL(path, base).href,
    { port: chrome.port, output: 'json', onlyCategories: categories, logLevel: 'error' },
    formFactor === 'desktop'
      ? {
          extends: 'lighthouse:default',
          settings: {
            formFactor: 'desktop',
            screenEmulation: { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1, disabled: false },
          },
        }
      : undefined,
  );
  if (!result) {
    throw new Error(`Lighthouse returned no result for ${path}`);
  }
  if (result.lhr.runtimeError) {
    throw new Error(`Lighthouse failed for ${path}: ${result.lhr.runtimeError.message}`);
  }
  return result.lhr;
}
try {
  for (const path of paths) {
    for (const formFactor of ['mobile', 'desktop']) {
      const reports = [];
      for (let run = 0; run < runs; run += 1) {
        reports.push(await audit(path, formFactor));
      }
      const scores = (key) => reports.map((lhr) => Math.round((lhr.categories[key]?.score ?? 0) * 100));
      const row = {
        path,
        formFactor,
        ...Object.fromEntries(categories.map((key) => [key, median(scores(key))])),
        runs: scores('performance').join(' '),
      };
      rows.push(row);
      const slug = path === '/' ? 'home' : path.slice(1).replaceAll('/', '-');
      const representative = reports.find((lhr) => Math.round(lhr.categories.performance.score * 100) === row.performance) ?? reports[0];
      await writeFile(
        resolve(output, `${slug}-${formFactor}.json`),
        JSON.stringify({ ...row, fetchTime: representative.fetchTime, audits: representative.audits }, null, 2),
      );
      console.log(
        `${path} ${formFactor}: ${row.performance}/${row.accessibility}/${row['best-practices']}/${row.seo} (performance runs: ${row.runs})`,
      );
    }
  }
  console.table(rows);
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(rows, null, 2));
  if (
    !process.argv.includes('--no-fail') &&
    // noindex pages (drafts, 404) lose SEO points by design.
    rows.some((row) => categories.some((key) => row[key] < 95 && !(key === 'seo' && noindex.has(row.path))))
  ) {
    process.exitCode = 1;
  }
} finally {
  await chrome.kill();
}
