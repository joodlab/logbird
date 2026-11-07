import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { siteConfigFrom } from '../src/env';
import { SOURCE_STATE_PHRASES } from '../src/lib/source-state';
import { loadPublicEnv } from './public-env';

/**
 * Checks the prerendered HTML against the repository's availability state (WEB_GITHUB_PUBLIC), resolved the same way
 * as the build. A public build must not say the source is still closed; a private build must say so somewhere.
 *
 *   pnpm build && pnpm check:source-state
 */
const publicDir = resolve('.output/public');
const { GITHUB_PUBLIC } = siteConfigFrom(loadPublicEnv());
const pages = (await readdir(publicDir, { recursive: true })).filter((path) => path.endsWith('.html'));
if (!pages.length) {
  throw new Error('No prerendered HTML in .output/public. Run pnpm build first.');
}
const found: string[] = [];
for (const page of pages) {
  const html = (await readFile(resolve(publicDir, page), 'utf8')).replaceAll('&#x27;', "'");
  for (const phrase of SOURCE_STATE_PHRASES) {
    const count = html.split(phrase).length - 1;
    if (count) {
      found.push(`${relative(publicDir, resolve(publicDir, page)).replaceAll('\\', '/')}: "${phrase}" ×${count}`);
    }
  }
}
if (GITHUB_PUBLIC && found.length) {
  throw new Error(`WEB_GITHUB_PUBLIC=true, but pages still say the source is closed:\n${found.join('\n')}`);
}
if (!(GITHUB_PUBLIC || found.length)) {
  throw new Error('The repository is private, but no page says so. Check the GITHUB_PUBLIC gates.');
}
console.log(
  `source-state: ${GITHUB_PUBLIC ? 'public' : 'private'} build, ${pages.length} pages, ${found.length} source-closed mentions${GITHUB_PUBLIC ? '' : ' (expected while private)'}.`,
);
