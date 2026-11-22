/**
 * Prerendered pages are written after Nitro's `compressPublicAssets` step, so the Node preview would serve them
 * uncompressed, and Nitro's own .br/.gz copies of a page predate the `email_off` wrap. compressTree (compress-tree.ts)
 * wraps every page, then rewrites any missing or stale .br/.gz sibling from the final bytes. (Cloudflare compresses on
 * its own.)
 */
import { resolve } from 'node:path';
import { compressTree } from './compress-tree';

const root = resolve(process.argv[2] ?? '.output/public');
const { marked, written } = await compressTree(root);
console.log(`compress-html: wrapped ${marked} pages, wrote ${written} .br/.gz files in ${root}`);
