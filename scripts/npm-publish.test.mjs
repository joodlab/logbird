import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { latestIsNewer, publishAssets } from './npm-publish.mjs';
import { writeSums } from './npm-release-assets.mjs';

const version = '1.2.3';
const files = ['sdk', 'hono', 'vue', 'nuxt', 'tanstack-start'].map((name) => `logbird-${name}-${version}.tgz`);

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'npm-publish-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  for (const file of files) writeFileSync(join(folder, file), file);
  writeSums(folder, files);
  return folder;
}

test('publishes SDK first, then adapters, all with latest', async (t) => {
  const published = [];
  await publishAssets(
    fixture(t),
    version,
    () => ({}),
    (path, tag) => published.push([basename(path), tag]),
  );
  assert.deepEqual(
    published,
    files.map((file) => [file, 'latest']),
  );
});

test('skips a matching SDK on a retry and completes the adapters', async (t) => {
  const published = [];
  const sdkIntegrity = `sha512-${createHash('sha512').update(files[0]).digest('base64')}`;
  await publishAssets(
    fixture(t),
    version,
    (name) => (name === '@logbird/sdk' ? { integrity: sdkIntegrity, latest: version } : {}),
    (path) => published.push(basename(path)),
  );
  assert.deepEqual(published, files.slice(1));
});

test('stops publishing at a version with different integrity', async (t) => {
  const published = [];
  await assert.rejects(
    publishAssets(
      fixture(t),
      version,
      (name) => (name === '@logbird/hono' ? { integrity: 'sha512-different', latest: version } : {}),
      (path) => published.push(basename(path)),
    ),
    /@logbird\/hono@1\.2\.3 already exists on npm with different integrity/,
  );
  assert.deepEqual(published, [files[0]]);
});

test('checks all tarballs before publishing and refuses prerelease versions', async (t) => {
  const folder = fixture(t);
  writeFileSync(join(folder, files.at(-1)), 'changed');
  const unexpected = () => assert.fail('must stop before contacting npm');
  await assert.rejects(publishAssets(folder, version, unexpected, unexpected), /does not match/);
  await assert.rejects(publishAssets(folder, '1.2.3-rc.1', unexpected, unexpected), /expected a release version X.Y.Z/);
});

test('a re-run of an older release leaves latest on the newer version', async (t) => {
  const published = [];
  const latest = { '@logbird/hono': '1.2.4', '@logbird/vue': '1.3.0', '@logbird/nuxt': '1.2.2', '@logbird/tanstack-start': '0.0.0-stage' };
  await publishAssets(
    fixture(t),
    version,
    (name) => ({ latest: latest[name] }),
    (path, tag) => published.push([basename(path), tag]),
  );
  assert.deepEqual(
    published,
    files.map((file, index) => [file, index === 1 || index === 2 ? 'backfill' : 'latest']),
  );
});

test('compares release versions as numbers and refuses a latest it cannot read', () => {
  assert.equal(latestIsNewer('1.10.0', '1.9.9'), true);
  assert.equal(latestIsNewer('2.0.0', '10.0.0'), false);
  assert.equal(latestIsNewer('1.2.3', '1.2.3'), false);
  assert.equal(latestIsNewer('1.2.3-rc.1', '1.2.3'), false);
  assert.throws(() => latestIsNewer('next', '1.2.3'), /not a version this job can compare/);
});
