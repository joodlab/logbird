import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assetVersionsModule, computeAssetVersions, computeOgDesignVersion } from './asset-versions-lib';

/**
 * Regenerates src/lib/asset-versions.ts and public/site.webmanifest (its icons' versioned URLs) after a capture, a brand
 * file, the encoder or the OG card design changes (docs/media/README.md). The media build and a test refuse stale ones.
 */
const app = resolve(import.meta.dirname, '..');
const { versions, manifestText } = await computeAssetVersions();
await writeFile(resolve(app, 'public/site.webmanifest'), manifestText);
await writeFile(resolve(app, 'src/lib/asset-versions.ts'), assetVersionsModule(versions, await computeOgDesignVersion()));
console.log(`asset-versions: ${Object.keys(versions).length} files.`);
