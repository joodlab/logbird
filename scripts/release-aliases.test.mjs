// node --test scripts/release-aliases.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedAliases, publishedCount, publishedVersions } from './release-aliases.mjs';

const release = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, ...extra });

test('only published stable vX.Y.Z releases count, across pages', () => {
  const pages = [
    [release('v0.3.0'), release('v0.3.1', { draft: true }), release('v0.4.0-rc.1', { prerelease: true })],
    [release('v0.2.1'), release('nightly')],
  ];
  assert.deepEqual(publishedVersions(pages).sort(), ['0.2.1', '0.3.0']);
});

test('the newest release takes both aliases', () => {
  assert.deepEqual(allowedAliases('0.3.1', ['0.2.1', '0.3.0', '0.3.1'], { requireOwn: true }), { minor: true, latest: true });
});

test('a late or re-run older release never moves an alias backwards', () => {
  // 0.3.1 failed, 0.3.2 shipped, then someone re-ran 0.3.1.
  assert.deepEqual(allowedAliases('0.3.1', ['0.3.0', '0.3.1', '0.3.2']), { minor: false, latest: false });
  // A patch on an older line keeps its X.Y but not latest.
  assert.deepEqual(allowedAliases('0.2.2', ['0.2.1', '0.2.2', '0.3.0']), { minor: true, latest: false });
});

test('aliases follow the release, never lead it', () => {
  assert.throws(() => allowedAliases('0.3.1', ['0.3.0'], { requireOwn: true }), /not published/);
  assert.deepEqual(allowedAliases('0.3.1', ['0.3.0']), { minor: true, latest: true });
});

test('versions compare numerically, and a bad version is refused', () => {
  assert.deepEqual(allowedAliases('0.10.0', ['0.9.9', '0.10.0']), { minor: true, latest: true });
  assert.deepEqual(allowedAliases('0.9.10', ['0.9.9', '0.10.0']), { minor: true, latest: false });
  assert.throws(() => allowedAliases('v0.3.1', []), /stable X\.Y\.Z/);
});

test('a tag counts as published only for a well-formed, non-draft release', () => {
  const pages = [[release('v1.2.3'), release('v1.2.4', { draft: true })]];
  assert.equal(publishedCount(pages, 'v1.2.3'), 1);
  assert.equal(publishedCount(pages, 'v1.2.4'), 0);
  assert.equal(publishedCount([[]], 'v1.2.3'), 0);
});

test('a malformed releases response is refused, never read as "no release"', () => {
  // jq would read the string "false" as true (not a draft-free match), giving a count of 0 and allowing a write.
  assert.throws(() => publishedCount([[{ tag_name: 'v1.2.3', draft: 'false', prerelease: false }]], 'v1.2.3'), /non-boolean draft/);
  assert.throws(() => publishedCount([[{ tag_name: 'v1.2.3', prerelease: false }]], 'v1.2.3'), /non-boolean draft/);
  assert.throws(() => publishedCount([[{ tag_name: 1, draft: false }]], 'v1.2.3'), /string tag_name/);
  assert.throws(() => publishedCount([[release('v1.2.3', { prerelease: 'no' })]], 'v1.2.3'), /non-boolean prerelease/);
  assert.throws(() => publishedCount([release('v1.2.3')], 'v1.2.3'), /page 0 is not an array/);
  assert.throws(() => publishedCount([[null]], 'v1.2.3'), /non-object/);
  assert.throws(() => publishedCount({ message: 'Not Found' }, 'v1.2.3'), /not an array of pages/);
  assert.throws(() => publishedVersions([[{ tag_name: 'v1.2.3', draft: 'false' }]]), /non-boolean draft/);
});
