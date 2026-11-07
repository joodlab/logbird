import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { siteConfigFrom } from '../src/env';
import { SOURCE_OPEN_PHRASES, SOURCE_STATE_PHRASES } from '../src/lib/source-state';
import { loadPublicEnv } from './public-env';

/**
 * Checks the prerendered HTML against the repository's availability state (WEB_GITHUB_PUBLIC), resolved the same way
 * as the build. A public build must not say the source is still closed. A private build must say so somewhere, and must
 * not say it's already open ("we released it", "Self-host it").
 *
 *   pnpm build && pnpm check:source-state
 */
const publicDir = resolve('.output/public');
const { GITHUB_PUBLIC } = siteConfigFrom(loadPublicEnv());
const pages = (await readdir(publicDir, { recursive: true })).filter((path) => path.endsWith('.html'));
if (!pages.length) {
  throw new Error('No prerendered HTML in .output/public. Run pnpm build first.');
}
const mentions = (html: string, where: string, phrases: readonly string[]) =>
  phrases.flatMap((phrase) => {
    const count = html.split(phrase).length - 1;
    return count ? [`${where}: "${phrase}" ×${count}`] : [];
  });
const closed: string[] = [];
const open: string[] = [];
for (const page of pages) {
  const html = (await readFile(resolve(publicDir, page), 'utf8')).replaceAll('&#x27;', "'");
  const where = relative(publicDir, resolve(publicDir, page)).replaceAll('\\', '/');
  closed.push(...mentions(html, where, SOURCE_STATE_PHRASES));
  open.push(...mentions(html, where, SOURCE_OPEN_PHRASES));
}
if (GITHUB_PUBLIC && closed.length) {
  throw new Error(`WEB_GITHUB_PUBLIC=true, but pages still say the source is closed:\n${closed.join('\n')}`);
}
if (!GITHUB_PUBLIC && open.length) {
  throw new Error(`The repository is private, but pages say the source is already open:\n${open.join('\n')}`);
}
if (!(GITHUB_PUBLIC || closed.length)) {
  throw new Error('The repository is private, but no page says so. Check the GITHUB_PUBLIC gates.');
}
console.log(
  `source-state: ${GITHUB_PUBLIC ? 'public' : 'private'} build, ${pages.length} pages, ${closed.length} source-closed and ${open.length} source-open mentions.`,
);
