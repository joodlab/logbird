import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'changelogithub';
import { compose, highlights, isPerson, parseLog, previousTag, resolveLogins, summarize } from './release-notes.mjs';

const config = await resolveConfig({ from: 'v0.0.1', to: 'v0.1.0', repo: 'acme/logbird', dry: true });
const person = (name, email) => ({ name, email });
const commit = (subject, people = [person('Alice', 'alice@example.test')]) => {
  const [author, ...coauthors] = people;
  return parseLog(
    `${'a'.repeat(40)}\x1f${author.name}\x1f${author.email}\x1f${subject}\n\n${coauthors.map((p) => `Co-Authored-By: ${p.name} <${p.email}>`).join('\n')}\x1e`,
    config,
  )[0];
};
const credits = (summary) => summary.contributors.map(({ label, first }) => ({ label, first }));

test('loads root changelogithub config with all type sections, scopes, breaking changes and contributors', () => {
  assert.deepEqual(
    Object.values(config.types).map((type) => type.title),
    [
      'Features',
      'Bug fixes',
      'Performance',
      'Refactoring',
      'Documentation',
      'Build',
      'CI',
      'Tests',
      'Maintenance',
      'Reverts',
      'Style',
      'Other changes',
    ],
  );
  assert.equal(config.titles.breakingChanges, 'Breaking changes');
  assert.equal(config.group, true);
  assert.equal(config.contributors, true);
  assert.equal(config.tagFilter('v0.2.0-rc.1'), false);
});

test('highlights select only the intended version and require one to three reviewed bullets', () => {
  const markdown = '## Unreleased\n\n## 0.1.0\n\n### Highlights\n\n- Ship the API.\n- Search events.\n\n### Changes\n\nMore.';
  assert.equal(highlights(markdown, 'v0.1.0'), '- Ship the API.\n- Search events.');
  for (const invalid of ['', '<!-- TODO -->', 'Prose without bullets.', '- One\n- Two\n- Three\n- Four']) {
    assert.throws(() => highlights(`## 0.1.0\n\n### Highlights\n\n${invalid}`, 'v0.1.0'), /1–3 highlight bullets/);
  }
  assert.throws(() => highlights(markdown, 'v0.2.0'), /section ## 0.2.0/);
});

test('counts human changes, credits human co-authors and merges aliases without AI or bots', () => {
  const parsed = commit('feat: API (#42)', [
    person('Alice', 'alice@example.test'),
    person('Bob', 'bob@example.test'),
    person('Claude Opus 5.5', 'noreply@anthropic.com'),
  ]);
  assert.equal(parsed.authors.length, 3);
  const logins = new Map([
    ['alice@example.test', 'alice'],
    ['alias@example.test', 'alice'],
    ['old@example.test', 'alice'],
    ['bob@example.test', 'bob'],
    ['automation@example.test', 'service'],
  ]);
  const commits = [
    parsed,
    commit('fix: API', [person('Alice', 'alias@example.test')]),
    commit('chore: dependencies', [person('dependency[bot]', 'bot@example.test'), person('Bob', 'bob@example.test')]),
    commit('chore: service', [person('Service', 'automation@example.test')]),
  ];
  const summary = summarize(commits, [commit('feat: initial', [person('Alice', 'old@example.test')])], logins, new Map([['service', 'Bot']]));
  assert.equal(summary.changes, 2);
  assert.deepEqual(credits(summary), [
    { label: '@alice', first: false },
    { label: '@bob', first: true },
  ]);
  assert.equal(isPerson(person('Claude Human', 'human@example.test')), true);
});

test('AI coding agents and RFC placeholder emails never count, including resolved GitHub accounts', () => {
  for (const email of [
    'agent@openai.com',
    'noreply@anthropic.com',
    'noreply@cursor.com',
    'noreply@githubcopilot.com',
    'codex@users.noreply.github.com',
    '123+github-actions[bot]@users.noreply.github.com',
    'dependabot@github.com',
    'someone@example.com',
    'someone@sub.example.net',
    'someone@example.org',
    'someone@invalid',
    'someone@localhost',
  ])
    assert.equal(isPerson({ ...person('Assistant', email), login: 'real-account' }), false, email);
  for (const login of ['codex', 'claude', 'copilot', 'cursor', 'cursoragent', 'devin-ai-integration'])
    assert.equal(isPerson({ ...person('Assistant', 'assistant@mail.test'), login }), false, login);
  const commits = [commit('feat: x', [person('Human', 'human@mail.test'), person('Codex', 'codex@users.noreply.github.com')])];
  assert.deepEqual(credits(summarize(commits, [], new Map([['codex@users.noreply.github.com', 'codex']]))), [{ label: 'Human', first: false }]);
});

test('Claude co-author trailer is excluded from both changelogithub inline credits and thank-you output', () => {
  const commits = [
    commit('feat(api): accept events (#42)', [person('Human', 'human@mail.test'), person('Claude Opus 5.5', 'noreply@anthropic.com')]),
  ];
  const summary = summarize(commits, [], new Map([['noreply@anthropic.com', 'claude']]));
  const output = compose({ version: 'v0.1.0', intro: '- Ship the API.', commits, summary, config });
  assert.match(output, /by \*\*Human\*\*/);
  assert.match(output, /### Thank you\n\n- Human/);
  assert.doesNotMatch(output, /claude|anthropic|codex|\[bot\]/i);
});

test('fails closed if an excluded identity reaches either rendered contributor list', () => {
  const commits = [commit('fix: x')];
  const summary = summarize(commits, [], new Map());
  for (const identity of [
    { name: 'Claude Opus 5.5', email: 'noreply@anthropic.com' },
    { name: 'Service', email: 'service@mail.test', type: 'Bot' },
    { name: 'Codex', email: 'human@mail.test', login: 'codex' },
  ]) {
    assert.throws(
      () => compose({ version: 'v0.1.0', intro: '- Ship.', commits: [{ ...commits[0], resolvedAuthors: [identity] }], summary, config }),
      /refusing to emit notes/,
    );
    assert.throws(
      () => compose({ version: 'v0.1.0', intro: '- Ship.', commits, summary: { ...summary, contributors: [identity] }, config }),
      /refusing to emit notes/,
    );
  }
});

test('changelogithub renders scoped sections, breaking changes, PR/commit links and escaped subjects', () => {
  const commits = [
    commit('feat(api)!: accept events (#42)'),
    commit('fix(api): escape </details> & [links] (#43)'),
    commit('fix(api): handle retries'),
    commit('Initial commit'),
    commit('unknown: preserve this change'),
    commit('Initial fix: keep the whole subject'),
  ];
  const summary = summarize(commits, [], new Map());
  const body = compose({ version: 'v0.1.0', intro: '- Ship the API.', commits, summary, config });
  assert.match(body, /^### Highlights\n\n- Ship the API\./);
  assert.match(body, /Breaking changes[\s\S]*accept events[\s\S]*Bug fixes/);
  assert.match(body, /- \*\*api\*\*:\n {2}- /);
  assert.match(body, /escape &lt;\/details&gt; &amp; \\\[links\\\]/);
  assert.match(body, /Other changes[\s\S]*Initial commit/);
  assert.match(body, /preserve this change/);
  assert.match(body, /Initial fix: keep the whole subject/);
  assert.match(body, /https:\/\/github.com\/acme\/logbird\/issues\/42/);
  assert.match(body, /\/commit\/aaaaaaaa/);
  assert.equal(body.match(/<details>/g).length, 1);
  assert.match(body, /\/compare\/v0.0.1\.\.\.v0.1.0/);
  const first = compose({ version: 'v0.1.0', intro: '- Ship.', commits, summary, config: { ...config, from: '' } });
  assert.match(first, /\/commits\/v0.1.0/);
  assert.doesNotMatch(first, /\/compare\//);
});

test('identity resolution rejects missing, truncated and failed responses instead of inventing contributors', () => {
  const commits = [commit('feat: API')];
  for (const response of [
    { errors: [{}] },
    { data: { repository: {} } },
    { data: { repository: { c0: null } } },
    { data: { repository: { c0: { authors: { nodes: [], pageInfo: { hasNextPage: true } } } } } },
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

test('first release includes the root commit; later releases select the nearest reachable stable tag', () => {
  const directory = mkdtempSync(join(tmpdir(), 'logbird-notes-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const addCommit = (message) =>
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', message);
  try {
    git('init');
    addCommit('feat: first');
    const first = git('rev-parse', 'HEAD');
    assert.equal(previousTag(first, git), undefined);
    assert.equal(parseLog(git('log', '--format=%H%x1f%an%x1f%ae%x1f%B%x1e', first), config).length, 1);
    git('tag', 'v0.9.0');
    addCommit('fix: second');
    git('tag', 'v0.1.0');
    addCommit('fix: third');
    git('tag', 'v0.2.0-rc.1');
    assert.equal(previousTag(git('rev-parse', 'HEAD'), git), 'v0.1.0');
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

test('merges a login with bare-name aliases and flags nobody first in the first release', () => {
  const commits = [
    commit('feat: a', [person('Owner Name', 'owner@users.noreply.github.com'), person('Owner Name', 'owner@example.com')]),
    commit('fix: b', [person('Owner Name', 'personal@mail.test')]),
  ];
  assert.deepEqual(credits(summarize(commits, [], new Map([['owner@users.noreply.github.com', 'owner']]))), [{ label: '@owner', first: false }]);
});
