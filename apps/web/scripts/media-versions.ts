import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { computeMediaVersions, mediaVersionsModule } from './media-versions-lib';

/** Regenerates src/lib/media-versions.ts after a capture or an encoder setting changes (docs/media/README.md). */
const versions = await computeMediaVersions();
await writeFile(resolve(import.meta.dirname, '../src/lib/media-versions.ts'), mediaVersionsModule(versions));
console.log(`media-versions: ${Object.keys(versions).length} files.`);
