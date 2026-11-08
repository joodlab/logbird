import { resolve } from 'node:path';
import { writeCsp } from '../src/lib/csp';

/**
 * After the build: hashes every prerendered page's inline scripts, writes `.output/csp.json` (Node server,
 * serve-static) and `.output/public/_headers` (Cloudflare), and fails if any inline script isn't covered
 * (src/lib/csp.ts). `pnpm build` and `pnpm build:cloudflare` run it last, once the HTML is final.
 */
const summary = await writeCsp(resolve('.output'));
console.log(
  `csp: ${summary.pages} pages, ${summary.hashes} distinct inline-script hashes, every inline script covered; _headers ${summary.rules} rules, longest line ${summary.longestLine} chars.`,
);
