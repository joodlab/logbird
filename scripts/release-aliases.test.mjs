// node --test scripts/release-aliases.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedAliases, publishedVersions } from './release-aliases.mjs';

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
