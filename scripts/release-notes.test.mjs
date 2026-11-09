import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compose, highlights, isPerson, parseLog, previousTag, resolveLogins, summarize } from './release-notes.mjs';

const person = (name, email) => ({ name, email });
const commit = (subject, people) => ({ sha: 'a'.repeat(40), subject, people });

test('highlights select only the intended version and require one to three reviewed bullets', () => {
  const markdown = '## Unreleased\n\n## 0.1.0\n\n### Highlights\n\n- Ship the API.\n- Search events.\n\n### Changes\n\nMore.';
  assert.equal(highlights(markdown, 'v0.1.0'), '- Ship the API.\n- Search events.');
  for (const invalid of ['', '<!-- TODO -->', 'Prose without bullets.', '- One\n- Two\n- Three\n- Four']) {
    assert.throws(() => highlights(`## 0.1.0\n\n### Highlights\n\n${invalid}`, 'v0.1.0'), /1–3 highlight bullets/);
  }
  assert.throws(() => highlights(markdown, 'v0.2.0'), /section ## 0.2.0/);
});

test('counts human changes, credits human co-authors and merges aliases without AI or bots', () => {
  const parsed = parseLog(
    'abc\x1fAlice\x1falice@example.test\x1ffeat: API (#42)\n\nCo-Authored-By: Bob <bob@example.test>\nCo-authored-by: Assistant <noreply@anthropic.com>\x1e',
  );
  assert.equal(parsed[0].people.length, 3);
  const logins = new Map([
    ['alice@example.test', 'alice'],
    ['alias@example.test', 'alice'],
    ['old@example.test', 'alice'],
    ['bob@example.test', 'bob'],
    ['automation@example.test', 'service'],
  ]);
  const commits = [
    ...parsed,
    commit('fix: API', [person('Alice', 'alias@example.test')]),
    commit('chore: dependencies', [person('dependency[bot]', 'bot@example.test'), person('Bob', 'bob@example.test')]),
    commit('chore: service', [person('Service', 'automation@example.test')]),
  ];
  assert.deepEqual(summarize(commits, [commit('feat: initial', [person('Alice', 'old@example.test')])], logins, new Map([['service', 'Bot']])), {
    changes: 2,
    contributors: [
      { label: '@alice', first: false },
      { label: '@bob', first: true },
    ],
  });
  assert.equal(isPerson(person('Claude Human', 'human@example.test')), true);
  for (const email of ['agent@openai.com', 'noreply@cursor.com', 'noreply@githubcopilot.com', '123+github-actions[bot]@users.noreply.github.com']) {
    assert.equal(isPerson(person('Assistant', email)), false);
  }
  assert.equal(summarize([commit('feat: API', [person('@unresolved', 'human@example.test')])], [], new Map()).contributors[0].label, 'unresolved');
});

test('formats conventional groups, PR links, escaped subjects, direct commits and first-release history', () => {
  const args = {
    version: 'v0.1.0',
    to: 'HEAD',
    repo: 'acme/logbird',
    intro: '- Ship the API.',
    summary: { changes: 3, contributors: [{ label: '@alice', first: true }] },
    commits: [commit('feat(api)!: accept events (#42)', []), commit('fix: escape </details> & [links] (#43)', []), commit('Initial commit', [])],
  };
  const body = compose(args);
  assert.match(body, /^\*\*v0.1.0\*\* · 3 changes from 1 contributor/);
  assert.match(body, /### Features\n\n- api: accept events \(breaking change\) \(\[#42\]\(https:\/\/github.com\/acme\/logbird\/pull\/42\)\)/);
  assert.match(body, /### Fixes/);
  assert.match(body, /escape &lt;\/details&gt; &amp; \\\[links\\\]/);
  assert.match(body, /### Other changes/);
  assert.match(body, /\/commit\/aaaaaaaa/);
  assert.equal(body.match(/<details>/g).length, 1);
  assert.match(body, /\/commits\/HEAD\)\n\n<\/details>\n\n### Thank you\n\n- @alice \(first-time contributor\)/);
  assert.match(compose({ ...args, from: 'v0.0.1' }), /\/compare\/v0.0.1\.\.\.HEAD/);
});

test('identity resolution rejects missing or truncated responses instead of inventing contributors', () => {
  const commits = [commit('feat: API', [])];
  for (const response of [
    { errors: [{}] },
    { data: { repository: { c0: null } } },
    {
      data: { repository: { c0: { authors: { nodes: [], pageInfo: { hasNextPage: true } } } } },
    },
  ])
    assert.throws(() => resolveLogins(commits, 'acme/logbird', () => JSON.stringify(response)), /lookup/);
  assert.throws(
    () =>
      resolveLogins(commits, 'acme/logbird', () => {
        throw new Error('offline');
      }),
    /offline/,
  );
});

test('first release includes the root commit; later releases select reachable stable tags', () => {
  const directory = mkdtempSync(join(tmpdir(), 'logbird-notes-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'feat: first',
    );
    const first = git('rev-parse', 'HEAD');
    assert.equal(previousTag(first, git), undefined);
    assert.equal(parseLog(git('log', '--format=%H%x1f%an%x1f%ae%x1f%B%x1e', first)).length, 1);
    git('tag', 'v0.1.0');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'fix: second',
    );
    git('tag', 'v0.2.0-rc.1');
    git('tag', 'v0.2.0');
    assert.equal(previousTag(git('rev-parse', 'HEAD'), git), 'v0.1.0');
    git('remote', 'add', 'origin', 'https://github.com/acme/logbird.git');
    writeFileSync(join(directory, 'CHANGELOG.md'), '## 0.1.0\n\n### Highlights\n');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./release-notes.mjs', import.meta.url)), '--dry', '--version', 'v0.1.0'], {
      cwd: directory,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /1–3 highlight bullets/);
    assert.equal(result.stdout, '');
    assert.equal(readFileSync(join(directory, 'CHANGELOG.md'), 'utf8'), '## 0.1.0\n\n### Highlights\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('merges a login with the same person under a placeholder or bare email, and flags nobody first in the first release', () => {
  const logins = new Map([['owner@users.noreply.github.com', 'owner']]);
  const commits = [
    commit('feat: a', [person('Owner Name', 'owner@users.noreply.github.com'), person('Owner Name', 'owner@example.com')]),
    commit('fix: b', [person('Owner Name', 'personal@mail.test')]),
  ];
  assert.deepEqual(summarize(commits, [], logins).contributors, [{ label: '@owner', first: false }]);
});

test('AI coding agents never count as contributors, even when GitHub resolves their noreply address to an account', () => {
  const logins = new Map([
    ['codex@users.noreply.github.com', 'codex'],
    ['human@users.noreply.github.com', 'human'],
  ]);
  const commits = [commit('feat: x', [person('Human', 'human@users.noreply.github.com'), person('Codex', 'codex@users.noreply.github.com')])];
  assert.deepEqual(summarize(commits, [], logins).contributors, [{ label: '@human', first: false }]);
});
