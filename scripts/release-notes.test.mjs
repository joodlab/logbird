import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'changelogithub';
import { applyMailmap, compose, highlights, isPerson, LOG_FORMAT, parseLog, previousTag, resolveLogins, summarize } from './release-notes.mjs';

const config = await resolveConfig({ from: 'v0.0.1', to: 'v0.1.0', repo: 'acme/logbird', dry: true });
const person = (name, email) => ({ name, email });
const commit = (subject, people = [person('Alice', 'alice@users.noreply.github.com')]) => {
  const [author, ...coauthors] = people;
  return parseLog(
    `${'a'.repeat(40)}\x1f${author.name}\x1f${author.email}\x1f${coauthors.map((p) => `${p.name} <${p.email}>`).join('\x1d')}\x1f${subject}\x1e`,
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
    person('Alice', 'alice@users.noreply.github.com'),
    person('Bob', 'bob@users.noreply.github.com'),
    person('Claude Opus 5.5', 'noreply@anthropic.com'),
  ]);
  assert.equal(parsed.authors.length, 3);
  const logins = new Map([
    ['alice@users.noreply.github.com', 'alice'],
    ['alias@users.noreply.github.com', 'alice'],
    ['old@users.noreply.github.com', 'alice'],
    ['bob@users.noreply.github.com', 'bob'],
    ['automation@users.noreply.github.com', 'service'],
  ]);
  const commits = [
    parsed,
    commit('fix: API', [person('Alice', 'alias@users.noreply.github.com')]),
    commit('chore: dependencies', [person('dependency[bot]', 'bot@users.noreply.github.com'), person('Bob', 'bob@users.noreply.github.com')]),
    commit('chore: service', [person('Service', 'automation@users.noreply.github.com')]),
  ];
  const summary = summarize(
    commits,
    [commit('feat: initial', [person('Alice', 'old@users.noreply.github.com')])],
    logins,
    new Map([['service', 'Bot']]),
  );
  assert.equal(summary.changes, 2);
  assert.deepEqual(credits(summary), [
    { label: '@alice', first: false },
    { label: '@bob', first: true },
  ]);
  assert.equal(isPerson(person('Claude Human', 'human@users.noreply.github.com')), true);
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
    assert.equal(isPerson({ ...person('Assistant', 'assistant@users.noreply.github.com'), login }), false, login);
  const commits = [commit('feat: x', [person('Human', 'human@users.noreply.github.com'), person('Codex', 'codex@users.noreply.github.com')])];
  assert.deepEqual(credits(summarize(commits, [], new Map([['codex@users.noreply.github.com', 'codex']]))), [{ label: 'Human', first: false }]);
});

test('Claude co-author trailer is excluded from both changelogithub inline credits and thank-you output', () => {
  const commits = [
    commit('feat(api): accept events (#42)', [person('Human', 'human@users.noreply.github.com'), person('Claude Opus 5.5', 'noreply@anthropic.com')]),
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
    { name: 'Service', email: 'service@users.noreply.github.com', type: 'Bot' },
    { name: 'Codex', email: 'human@users.noreply.github.com', login: 'codex' },
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
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@users.noreply.github.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      message,
    );
  try {
    git('init');
    addCommit('feat: first');
    const first = git('rev-parse', 'HEAD');
    assert.equal(previousTag(first, git), undefined);
    assert.equal(parseLog(git('log', `--format=${LOG_FORMAT}`, first), config).length, 1);
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

test('never merges people by display name; only a verified login or .mailmap joins identities', () => {
  const commits = [
    commit('feat: a', [person('Alex Smith', 'alex.one@users.noreply.github.com')]),
    commit('fix: b', [person('Alex Smith', 'alex.two@users.noreply.github.com')]),
  ];
  const summary = summarize(commits, [], new Map([['alex.one@users.noreply.github.com', 'alex-one']]));
  assert.deepEqual(credits(summary), [
    { label: '@alex-one', first: false },
    { label: 'Alex Smith', first: false },
  ]);
  assert.deepEqual(
    commits[1].resolvedAuthors.map((entry) => entry.login ?? entry.name),
    ['Alex Smith'],
  );
});

test('.mailmap maps co-authors (and LOG_FORMAT authors) to one canonical identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'logbird-mailmap-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q');
    writeFileSync(join(directory, '.mailmap'), 'Owner Name <owner@users.noreply.github.com> <personal@users.noreply.github.com>\n');
    writeFileSync(join(directory, 'message.txt'), 'feat: pair\n\nBody.\n\nCo-authored-by: Owner Name <personal@users.noreply.github.com>\n');
    git(
      '-c',
      'user.name=Old Name',
      '-c',
      'user.email=personal@users.noreply.github.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-F',
      join(directory, 'message.txt'),
    );
    const check = (contacts) =>
      execFileSync('git', ['check-mailmap', '--stdin'], { cwd: directory, encoding: 'utf8', input: `${contacts.join('\n')}\n` });
    const commits = applyMailmap(parseLog(git('log', `--format=${LOG_FORMAT}`), config), check);
    assert.deepEqual(
      commits[0].authors.map(({ name, email }) => ({ name, email })),
      [
        { name: 'Owner Name', email: 'owner@users.noreply.github.com' },
        { name: 'Owner Name', email: 'owner@users.noreply.github.com' },
      ],
    );
    assert.deepEqual(
      commits[0].authors.map((person) => person.rawName),
      ['Old Name', 'Owner Name'],
    );
    // A co-author name beginning with "-" is data, not an option.
    assert.equal(check(['-k <dash@users.noreply.github.com>']).trim(), '-k <dash@users.noreply.github.com>');
    const summary = summarize(commits, [], new Map([['owner@users.noreply.github.com', 'owner']]));
    assert.deepEqual(credits(summary), [{ label: '@owner', first: false }]);
    assert.deepEqual(
      commits[0].resolvedAuthors.map((entry) => entry.login),
      ['owner'],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reserved .test addresses are never credited, with or without a GitHub login', () => {
  for (const email of ['assistant@example.test', 'someone@mail.test', 'ci@sub.example.test'])
    assert.equal(isPerson(person('Assistant', email)), false, email);
  const commits = [commit('feat: x', [person('Human', 'human@users.noreply.github.com'), person('Assistant', 'assistant@example.test')])];
  const summary = summarize(commits, [], new Map([['assistant@example.test', 'realperson']]));
  assert.deepEqual(credits(summary), [{ label: 'Human', first: false }]);
  assert.doesNotMatch(compose({ version: 'v0.1.0', intro: '- Ship.', commits, summary, config }), /Assistant|realperson/);
});

test('scopes named like Object.prototype members render instead of crashing', () => {
  const log = ['constructor', '__proto__', 'toString', 'hasOwnProperty']
    .map((scope, index) => `${index}abc\x1fHuman\x1fhuman@users.noreply.github.com\x1f\x1ffix(${scope}): handle ${scope}\x1e`)
    .join('');
  const commits = parseLog(log, config);
  assert.deepEqual(
    commits.map((entry) => [entry.type, entry.scope, entry.description]),
    [
      ['fix', '', 'constructor: handle constructor'],
      ['fix', '', '__proto__: handle __proto__'],
      ['fix', '', 'toString: handle toString'],
      ['fix', '', 'hasOwnProperty: handle hasOwnProperty'],
    ],
  );
  const summary = summarize(commits, [], new Map());
  const output = compose({ version: 'v0.1.0', intro: '- Ship.', commits, summary, config });
  assert.match(output, /constructor: handle constructor/);
  assert.match(output, /\\_\\_proto\\_\\_: handle \\_\\_proto\\_\\_/);
});

test('a BREAKING CHANGE footer puts the commit under Breaking changes', () => {
  const log = [
    'aaa1\x1fHuman\x1fhuman@users.noreply.github.com\x1f\x1ffeat(sdk): require project keys\n\nBREAKING CHANGE: anonymous ingestion is removed\x1e',
    'aaa2\x1fHuman\x1fhuman@users.noreply.github.com\x1f\x1ffix: tidy\n\nBREAKING-CHANGE: renamed flag\x1e',
    'aaa3\x1fHuman\x1fhuman@users.noreply.github.com\x1f\x1ffeat: unrelated\n\nMentions a breaking change in prose.\x1e',
  ].join('');
  const commits = parseLog(log, config);
  assert.deepEqual(
    commits.map((entry) => entry.isBreaking),
    [true, true, false],
  );
  const output = compose({ version: 'v0.1.0', intro: '- Ship.', commits, summary: summarize(commits, [], new Map()), config });
  const breaking = output.slice(output.indexOf('Breaking changes'), output.indexOf('Features'));
  assert.match(breaking, /require project keys/);
  assert.match(breaking, /tidy/);
  assert.doesNotMatch(breaking, /unrelated/);
});

// One `git log --format=LOG_FORMAT` record; `coAuthors` is git's parsed Co-authored-by trailer values.
const record = (subject, body = '', author = ['Human', 'human@users.noreply.github.com'], coAuthors = []) =>
  `abc1234\x1f${author[0]}\x1f${author[1]}\x1f${coAuthors.join('\x1d')}\x1f${subject}${body ? `\n\n${body}` : ''}\x1e`;

test('agent identities are excluded by vendor domain, known address and display name', () => {
  for (const [name, email] of [
    ['Cursor Agent', 'cursoragent@cursor.com'],
    ['Claude', 'claude-code@anthropic.com'],
    ['Gemini', 'gemini-cli@google.com'],
    ['Aider', 'noreply@aider.chat'],
    ['Claude Opus 5.5', 'someone@users.noreply.github.com'],
    ['Gemini CLI', 'someone@users.noreply.github.com'],
    ['Jules', 'someone@users.noreply.github.com'],
  ])
    assert.equal(isPerson(person(name, email)), false, `${name} <${email}>`);
  for (const name of ['Claude Human', 'Claudette', 'Jules Verne']) assert.equal(isPerson(person(name, 'h@users.noreply.github.com')), true, name);
});

test('@ mentions in subjects never notify accounts', () => {
  const commits = parseLog(record('fix(api): thanks @codex and bump @types/node (#7)'), config);
  const output = compose({ version: 'v0.1.0', intro: '- Ship.', commits, summary: summarize(commits, [], new Map()), config });
  assert.doesNotMatch(output, /@codex|@types/);
  assert.match(output, /@\u200bcodex/);
});

test('identities whose names sanitize to nothing are not credited, and compose refuses them', () => {
  const commits = parseLog(record('fix: x', '', undefined, ['*** <stars@users.noreply.github.com>']), config);
  const summary = summarize(commits, [], new Map());
  assert.deepEqual(
    summary.contributors.map((person) => person.label),
    ['Human'],
  );
  assert.doesNotMatch(compose({ version: 'v0.1.0', intro: '- Ship.', commits, summary, config }), /by \*\*\*\*|^- $/m);
  assert.throws(
    () =>
      compose({
        version: 'v0.1.0',
        intro: '- Ship.',
        commits,
        summary: { ...summary, contributors: [{ name: '***', email: 'stars@users.noreply.github.com', label: '' }] },
        config,
      }),
    /refusing to emit notes/,
  );
});

test('scopes are parsed non-greedily and unknown or malformed types stay whole under Other changes', () => {
  const [greedy, underscore, unknown] = parseLog(
    record('fix(ui): handle (retry): ok') + record('fix_up: lost prefix') + record('wip(sdk): spike'),
    config,
  );
  assert.deepEqual([greedy.type, greedy.scope, greedy.description], ['fix', 'ui', 'handle (retry): ok']);
  assert.deepEqual([underscore.type, underscore.description], ['other', 'fix_up: lost prefix']);
  assert.deepEqual([unknown.type, unknown.description], ['other', 'wip(sdk): spike']);
});

test('the summary line pluralizes changes', () => {
  const commits = parseLog(record('fix: one'), config);
  assert.match(
    compose({ version: 'v0.1.0', intro: '- Ship.', commits, summary: summarize(commits, [], new Map()), config }),
    /· 1 change from 1 contributor\n/,
  );
});

test('padded identities are trimmed before the exclusion rules run', () => {
  const commits = parseLog(
    record(
      'feat: pair',
      'Body.',
      [' Human ', ' human@users.noreply.github.com '],
      ['  Assistant  < cursoragent@cursor.com >', 'QA <assistant@example.test >'],
    ),
    config,
  );
  assert.deepEqual(commits[0].authors, [
    { name: 'Human', email: 'human@users.noreply.github.com' },
    { name: 'Assistant', email: 'cursoragent@cursor.com' },
    { name: 'QA', email: 'assistant@example.test' },
  ]);
  const summary = summarize(commits, [], new Map());
  assert.deepEqual(
    summary.contributors.map((person) => person.label),
    ['Human'],
  );
  assert.doesNotMatch(compose({ version: 'v0.1.0', intro: '- Ship.', commits, summary, config }), /Assistant|QA/);
});

test('CRLF messages keep their type, scope, breaking marks and trailers', () => {
  const [commit] = parseLog(
    record('feat(sdk)!: remove old API', 'Details.\r\n\r\nBREAKING CHANGE: gone\r\nCo-authored-by: Jane <jane@users.noreply.github.com>', undefined, [
      'Jane <jane@users.noreply.github.com>',
    ]).replace('remove old API\n\n', 'remove old API\r\n\r\n'),
    config,
  );
  assert.deepEqual([commit.type, commit.scope, commit.description, commit.isBreaking], ['feat', 'sdk', 'remove old API', true]);
  assert.deepEqual(
    commit.authors.map((person) => person.name),
    ['Human', 'Jane'],
  );
});

test('an unknown type with ! renders whole under Breaking changes', () => {
  const commits = parseLog(record('security(sdk)!: remove unsafe mode'), config);
  assert.deepEqual([commits[0].type, commits[0].description, commits[0].isBreaking], ['other', 'security(sdk)!: remove unsafe mode', true]);
  const output = compose({ version: 'v0.1.0', intro: '- Ship.', commits, summary: summarize(commits, [], new Map()), config });
  assert.match(output.slice(output.indexOf('Breaking changes')), /^- security\(sdk\)!: remove unsafe mode/m);
  assert.doesNotMatch(output, /Other changes/);
});

test('co-authors come from git trailer parsing: only the real trailer block counts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'logbird-trailers-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const jane = 'Co-authored-by: Jane <jane@users.noreply.github.com>';
  const cases = {
    trailerBlock: [`Body.\n\n${jane}\nSigned-off-by: Human <human@users.noreply.github.com>`, ['Jane']],
    githubSquash: [`* fix: a\n\n* fix: b\n\n---------\n\n${jane}`, ['Jane']],
    cherryPicked: [`Body.\n\n${jane}\n(cherry picked from commit ${'b'.repeat(40)})`, ['Jane']],
    proseInLastParagraph: [`Body.\n\n${jane}\nand then some prose`, []],
    fencedThenProse: ['Example:\n\n```\nCo-authored-by: Jane Doe <jane@acme.io>\n```\n\nThat is how pairing is credited.', []],
    proseOnly: ['Use co-authored-by: Jane Doe <jane@acme.io> in prose.', []],
    // In a commit message (unlike patch input) a --- line is ordinary text: the final paragraph is a trailer block.
    afterDashLine: [`Body.\n\n---\n\n${jane}`, ['Jane']],
  };
  try {
    git('init', '-q');
    for (const [key, [body]] of Object.entries(cases)) {
      const file = join(directory, 'message.txt');
      writeFileSync(file, `fix: ${key}\n\n${body}\n`);
      git(
        '-c',
        'user.name=Human',
        '-c',
        'user.email=human@users.noreply.github.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--allow-empty',
        '--cleanup=verbatim',
        '-F',
        file,
      );
    }
    const commits = parseLog(git('log', '--reverse', `--format=${LOG_FORMAT}`), config);
    assert.deepEqual(
      Object.fromEntries(commits.map((entry) => [entry.description, entry.authors.slice(1).map((person) => person.name)])),
      Object.fromEntries(Object.entries(cases).map(([key, [, expected]]) => [key, expected])),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('more agent vendors, subdomains and team agent mailboxes are excluded; a resolved human named Claude is not', () => {
  for (const [name, email] of [
    ['Amp', 'amp@ampcode.com'],
    ['openhands', 'openhands@all-hands.dev'],
    ['Windsurf', 'windsurf@codeium.com'],
    ['Augment Code', 'agent@augmentcode.com'],
    ['Someone', 'x@mail.anthropic.com'],
    ['Raed Bahri', 'claude@joodlab.com'],
    ['Team', 'codex-agent@example-team.dev'],
  ])
    assert.equal(isPerson(person(name, email)), false, `${name} <${email}>`);
  assert.equal(isPerson({ ...person('Claude', 'claude.dupont@users.noreply.github.com'), login: 'cdupont', type: 'User' }), true);
  assert.equal(isPerson(person('Claude', 'claude.dupont@users.noreply.github.com')), false);
});

test('the real #70 agent mailbox trailer is dropped from inline credits and Thank you', () => {
  const commits = parseLog(
    record('feat(sdk): pair (#70)', 'Body.', ['Raed Bahri', 'raed@users.noreply.github.com'], ['Raed Bahri <claude@joodlab.com>']),
    config,
  );
  const summary = summarize(commits, [], new Map([['raed@users.noreply.github.com', 'raedbahri']]), new Map([['raedbahri', 'User']]));
  assert.deepEqual(
    commits[0].resolvedAuthors.map((entry) => entry.login ?? entry.name),
    ['raedbahri'],
  );
  const output = compose({ version: 'v0.1.0', intro: '- Ship.', commits, summary, config });
  assert.match(output, /by @raedbahri/);
  assert.doesNotMatch(output, /\*\*Raed Bahri\*\*|claude/i);
  assert.match(output, /### Thank you\n\n- @raedbahri\n/);
});

test('relative --output and --changelog paths resolve from where the command runs; the default changelog from the root', () => {
  const directory = mkdtempSync(join(tmpdir(), 'logbird-paths-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q');
    git(
      '-c',
      'user.name=Human',
      '-c',
      'user.email=human@users.noreply.github.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'feat: first',
    );
    git('remote', 'add', 'origin', 'https://github.com/acme/logbird.git');
    mkdirSync(join(directory, 'apps', 'app'), { recursive: true });
    writeFileSync(join(directory, 'CHANGELOG.md'), '## 0.1.0\n\n### Highlights\n');
    const script = fileURLToPath(new URL('./release-notes.mjs', import.meta.url));
    // Run from a subdirectory: the root CHANGELOG.md is found (and rejected for its empty Highlights), not apps/app's.
    const fromSubdirectory = spawnSync(process.execPath, [script, '--dry', '--version', 'v0.1.0'], {
      cwd: join(directory, 'apps', 'app'),
      encoding: 'utf8',
    });
    assert.match(fromSubdirectory.stderr, /1–3 highlight bullets/);
    // An explicit relative changelog resolves against the caller's directory.
    writeFileSync(join(directory, 'apps', 'app', 'NOTES.md'), '## 0.1.0\n\n### Highlights\n\n<!-- todo -->\n');
    const explicit = spawnSync(process.execPath, [script, '--dry', '--version', 'v0.1.0', '--changelog', 'NOTES.md'], {
      cwd: join(directory, 'apps', 'app'),
      encoding: 'utf8',
    });
    assert.match(explicit.stderr, /1–3 highlight bullets/);
    assert.doesNotMatch(explicit.stderr, /ENOENT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('identity lookups ask GitHub once per new email', () => {
  const commits = ['feat: a', 'fix: b', 'fix: c'].map((subject) => ({ ...commit(subject), shortHash: subject.at(-1).repeat(7) }));
  const queries = [];
  const gh = (...args) => {
    if (args[1] === 'graphql') {
      queries.push(args.at(-1));
      return JSON.stringify({
        data: {
          repository: {
            c0: { authors: { nodes: [{ email: 'alice@users.noreply.github.com', user: { login: 'alice' } }], pageInfo: { hasNextPage: false } } },
          },
        },
      });
    }
    return JSON.stringify({ type: 'User' });
  };
  const { logins } = resolveLogins(commits, 'acme/logbird', gh);
  assert.equal(queries.length, 1);
  assert.equal((queries[0].match(/object\(oid/g) ?? []).length, 1);
  assert.equal(logins.get('alice@users.noreply.github.com'), 'alice');
});

test('.mailmap aliases keep the GitHub login GitHub reports for the address as committed', () => {
  // Pat's newest commit used an unlinked laptop address; the older one the linked address. .mailmap joins them.
  const commits = [
    { ...commit('feat: newer'), shortHash: 'n'.repeat(7) },
    { ...commit('fix: older'), shortHash: 'o'.repeat(7) },
  ];
  commits[0].authors = [{ name: 'Pat', email: 'pat@linked.dev', rawName: 'Pat', rawEmail: 'pat@laptop.local' }];
  commits[1].authors = [{ name: 'Pat', email: 'pat@linked.dev', rawName: 'Pat', rawEmail: 'pat@linked.dev' }];
  const answers = { nnnnnnn: { email: 'pat@laptop.local', user: null }, ooooooo: { email: 'pat@linked.dev', user: { login: 'pat' } } };
  const gh = (...args) => {
    if (args[1] !== 'graphql') return JSON.stringify({ type: 'User' });
    const oids = [...args.at(-1).matchAll(/oid: "(\w+)"/g)].map((match) => match[1]);
    return JSON.stringify({
      data: {
        repository: Object.fromEntries(
          oids.map((oid, index) => [`c${index}`, { authors: { nodes: [answers[oid]], pageInfo: { hasNextPage: false } } }]),
        ),
      },
    });
  };
  const { logins, accountTypes } = resolveLogins(commits, 'acme/logbird', gh);
  assert.equal(logins.get('pat@linked.dev'), 'pat');
  const summary = summarize(commits, [], logins, accountTypes);
  assert.deepEqual(credits(summary), [{ label: '@pat', first: false }]);
  assert.deepEqual(
    commits.map((entry) => entry.resolvedAuthors.map((person) => person.login)),
    [['pat'], ['pat']],
  );
});

test('a .mailmap line cannot launder an agent identity into human credit', () => {
  const commits = [commit('feat: pair')];
  commits[0].authors = [
    { name: 'Human', email: 'human@users.noreply.github.com', rawName: 'Human', rawEmail: 'human@users.noreply.github.com' },
    { name: 'Human', email: 'human@users.noreply.github.com', rawName: 'Raed Bahri', rawEmail: 'claude@joodlab.com' },
  ];
  const summary = summarize(commits, [], new Map());
  assert.equal(commits[0].resolvedAuthors.length, 1);
  assert.equal(summary.changes, 1);
  // An agent-authored commit, even mailmapped to a human, is neither credited nor counted as a human change.
  const agentCommit = [commit('fix: by agent')];
  agentCommit[0].authors = [{ name: 'Human', email: 'human@users.noreply.github.com', rawName: 'Codex', rawEmail: 'codex@users.noreply.github.com' }];
  const agentSummary = summarize(agentCommit, [], new Map());
  assert.equal(agentSummary.changes, 0);
  assert.deepEqual(agentSummary.contributors, []);
});
