import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkVersions, repositoryVersion } from './check-version-consistency.mjs';
import { requireQuality } from './release-preflight.mjs';

test('all manifests, including examples and integrations, must match the stable tag', () => {
  const manifests = [
    ['package.json', { version: '0.1.0' }],
    ['examples/demo/package.json', { version: '0.1.0' }],
  ];
  assert.equal(checkVersions(manifests, 'v0.1.0'), '0.1.0');
  assert.throws(() => checkVersions(manifests, 'v0.2.0'), /must match/);
  assert.throws(() => checkVersions([...manifests, ['packages/sdk/package.json', { version: '0.2.0' }]]), /packages\/sdk/);
  for (const version of ['01.0.0', '0.1.0-rc.1', undefined]) assert.throws(() => checkVersions([['package.json', { version }]]), /X.Y.Z/);
  assert.equal(repositoryVersion(), JSON.parse(readFileSync('package.json', 'utf8')).version);
});

test('requires the latest exact-head Quality from successful master CI, rejects PRs and lookalikes', () => {
  const sha = 'a'.repeat(40);
  const check = {
    id: 1,
    name: 'Quality',
    app: { slug: 'github-actions' },
    check_suite: { id: 42 },
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
  };
  const workflow = {
    check_suite_id: 42,
    path: '.github/workflows/ci.yml',
    head_sha: sha,
    head_branch: 'master',
    event: 'push',
    conclusion: 'success',
  };
  assert.equal(requireQuality([check], workflow, sha), check);
  for (const override of [
    { status: 'queued' },
    { conclusion: 'failure' },
    { conclusion: 'skipped' },
    { head_sha: 'other' },
    { app: { slug: 'other' } },
  ]) {
    assert.throws(() => requireQuality([{ ...check, ...override }], workflow, sha), /latest.*Quality/);
  }
  assert.throws(() => requireQuality([check, { ...check, id: 2, conclusion: 'failure' }], workflow, sha), /latest.*Quality/);
  assert.throws(() => requireQuality([], workflow, sha), /latest.*Quality/);
  for (const override of [
    { check_suite_id: 99 },
    { path: '.github/workflows/other.yml' },
    { event: 'pull_request' },
    { head_sha: 'other' },
    { head_branch: 'topic' },
    { conclusion: 'failure' },
  ]) {
    assert.throws(() => requireQuality([check], { ...workflow, ...override }, sha), /successful ci.yml/);
  }
});
