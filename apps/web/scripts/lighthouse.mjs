import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { prerenderPaths } from '../src/lib/site-map.ts';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:4620';
const output = resolve(process.env.OUT_DIR ?? '.tmp/lighthouse');
await mkdir(output, { recursive: true });
const chrome = await launch({ chromeFlags: ['--headless=new', '--disable-gpu'], port: 0 });
const rows = [];
try {
  for (const path of prerenderPaths) {
    for (const formFactor of ['mobile', 'desktop']) {
      const result = await lighthouse(
        new URL(path, base).href,
        { port: chrome.port, output: 'json', onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'], logLevel: 'error' },
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
      const row = {
        path,
        formFactor,
        ...Object.fromEntries(
          Object.entries(result.lhr.categories).map(([key, value]) => [key, value.score === null ? 0 : Math.round(value.score * 100)]),
        ),
      };
      rows.push(row);
      const slug = path === '/' ? 'home' : path.slice(1).replaceAll('/', '-');
      await writeFile(
        resolve(output, `${slug}-${formFactor}.json`),
        JSON.stringify({ ...row, fetchTime: result.lhr.fetchTime, audits: result.lhr.audits }, null, 2),
      );
      console.log(`${path} ${formFactor}: ${row.performance}/${row.accessibility}/${row['best-practices']}/${row.seo}`);
    }
  }
  console.table(rows);
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(rows, null, 2));
  if (
    !process.argv.includes('--no-fail') &&
    rows.some((row) => ['performance', 'accessibility', 'best-practices', 'seo'].some((key) => row[key] < 95))
  ) {
    process.exitCode = 1;
  }
} finally {
  await chrome.kill();
}
