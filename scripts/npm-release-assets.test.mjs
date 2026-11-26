// node --test scripts/npm-release-assets.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { PACKAGES, parseSums, SUMS, tarballName, verifyAssets, writeSums } from './npm-release-assets.mjs';

const folders = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A folder holding a fictional asset set for `version` (the tarball bytes do not matter here). */
function assetSet(version = '1.2.3') {
  const folder = mkdtempSync(join(tmpdir(), 'npm-release-assets-'));
  folders.push(folder);
  const files = PACKAGES.map(({ name }) => tarballName(name, version));
  for (const file of files) writeFileSync(join(folder, file), `fictional ${file}`);
  writeSums(folder, files);
  return { folder, files };
}

test('tarball names are what pnpm pack writes', () => {
  assert.equal(tarballName('@logbird/sdk', '1.2.3'), 'logbird-sdk-1.2.3.tgz');
  assert.equal(tarballName('@logbird/tanstack-start', '1.2.3'), 'logbird-tanstack-start-1.2.3.tgz');
});

test('a complete, unaltered set verifies, tarballs first and SHA256SUMS last', () => {
  const { folder, files } = assetSet();
  const assets = verifyAssets(folder, '1.2.3');
  assert.deepEqual(
    assets.map((a) => a.file),
    [...files, SUMS],
  );
  assert.ok(assets.every((a) => /^[0-9a-f]{64}$/.test(a.sha256) && a.bytes > 0));
});

test('SHA256SUMS is in the format sha256sum --check reads', () => {
  const { folder } = assetSet();
  const entries = parseSums(
    writeSums(
      folder,
      PACKAGES.map(({ name }) => tarballName(name, '1.2.3')),
    ),
  );
  assert.equal(entries.size, PACKAGES.length);
  assert.throws(() => parseSums('abc  logbird-sdk-1.2.3.tgz\n'), /malformed/);
  assert.throws(() => parseSums(`${'a'.repeat(64)}  ../logbird-sdk-1.2.3.tgz\n`), /malformed/);
  assert.throws(() => parseSums(`${'a'.repeat(64)}  x.tgz\n${'b'.repeat(64)}  x.tgz\n`), /twice/);
});

test('an altered tarball is refused', () => {
  const { folder, files } = assetSet();
  writeFileSync(join(folder, files[0]), 'other bytes');
  assert.throws(() => verifyAssets(folder, '1.2.3'), /does not match its SHA256SUMS entry/);
});

test('a missing or extra file, or another version, is refused', () => {
  const missing = assetSet();
  rmSync(join(missing.folder, missing.files[1]));
  assert.throws(() => verifyAssets(missing.folder, '1.2.3'), /Missing: logbird-hono-1\.2\.3\.tgz/);

  const extra = assetSet();
  writeFileSync(join(extra.folder, 'logbird-contracts-1.2.3.tgz'), 'x');
  assert.throws(() => verifyAssets(extra.folder, '1.2.3'), /Unexpected: logbird-contracts-1\.2\.3\.tgz/);

  const other = assetSet('1.2.4');
  assert.throws(() => verifyAssets(other.folder, '1.2.3'), /Missing/);
  assert.throws(() => verifyAssets(other.folder, 'v1.2.4'), /expected a release version/);
});

test('SHA256SUMS must list exactly the tarballs', () => {
  const { folder, files } = assetSet();
  writeSums(folder, files.slice(1));
  assert.throws(() => verifyAssets(folder, '1.2.3'), /must list exactly/);
});
