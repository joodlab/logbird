import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { generateMarkdown, parseCommits, resolveConfig } from 'changelogithub';

// AI coding agents and automation sign commits with these addresses; GitHub can map some of them to real
// accounts (e.g. codex@users.noreply.github.com resolves to @codex), so match the address, not the login.
const excludedEmail =
  /@openai\.com$|^noreply@(?:anthropic\.com|cursor\.com|githubcopilot\.com)$|^(?:\d+\+)?(?:dependabot|github-actions|codex|claude|copilot|cursor(?:agent)?|devin-ai-integration)(?:\[bot\])?@(?:users\.noreply\.github\.com|github\.com)$/i;
const excludedLogin = /^(?:codex|claude|copilot|cursor(?:agent)?|devin-ai-integration)$/i;

// Reserved documentation/test domains (RFC 2606/6761, e.g. history-scrubbed addresses) never identify a real contributor.
const placeholderEmail = /@(?:[\w-]+\.)*(?:example\.(?:com|net|org)|example|invalid|localhost)$/i;

export function isPerson({ name = '', email = '', login = '', type }) {
  return (
    type !== 'Bot' &&
    !/\[bot\]/i.test(`${name} ${email} ${login}`) &&
    !excludedEmail.test(email) &&
    !excludedLogin.test(login) &&
    !placeholderEmail.test(email)
  );
}

export function highlights(markdown, version) {
  const heading = version.replace(/^v/, '');
  const section = [...markdown.matchAll(/^## (.+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].find((match) => match[1] === heading);
  const text = section?.[2].match(/^### Highlights\r?\n([\s\S]*?)(?=^### |$(?![\s\S]))/m)?.[1].trim();
  const bullets = text?.split(/\r?\n/).filter(Boolean);
  if (!bullets?.length || bullets.length > 3 || bullets.some((line) => !/^- \S/.test(line)) || text.includes('<!--')) {
    throw new Error(`Add 1–3 highlight bullets under ### Highlights in CHANGELOG.md section ## ${heading}.`);
  }
  return text;
}

export function parseLog(log, config) {
  return log
    .split('\x1e')
    .filter((record) => record.trim())
    .map((record) => {
      const [sha, name, email, ...parts] = record.trim().split('\x1f');
      const [message, ...body] = parts.join('\x1f').split('\n');
      const raw = { shortHash: sha, message, body: body.join('\n'), author: { name, email } };
      // Changelogen drops non-conventional messages. Preserve our existing Other changes guarantee.
      if (!/^\w+(?:\([^)]+\))?!?: /.test(message)) raw.message = `other: ${message}`;
      const commit = parseCommits([raw], config)[0] ?? parseCommits([{ ...raw, message: `other: ${message}` }], config)[0];
      if (!config.types[commit.type]) commit.type = 'other';
      return commit;
    });
}

function identity(person, logins, accountTypes) {
  const login = logins.get(person.email.toLowerCase());
  return { ...person, login, type: accountTypes.get(login), key: login?.toLowerCase() ?? person.email.toLowerCase() };
}

export function summarize(commits, previous, logins, accountTypes = new Map()) {
  const peopleFor = (commit) => commit.authors.map((person) => identity(person, logins, accountTypes)).filter(isPerson);
  for (const commit of commits) commit.resolvedAuthors = peopleFor(commit);
  const old = new Set(previous.flatMap(peopleFor).map((person) => person.key));
  const people = new Map(commits.flatMap(peopleFor).map((person) => [person.key, person]));
  // The same human can appear under a GitHub login and as a bare name/email; keep the login entry.
  const loginNames = new Set([...people.values()].filter((person) => person.login).map((person) => person.name.toLowerCase()));
  for (const [key, person] of people) if (!person.login && loginNames.has(person.name.toLowerCase())) people.delete(key);
  // Nobody is a "first-time contributor" in the very first release.
  const firstRelease = previous.length === 0;
  return {
    changes: commits.filter((commit) => isPerson(identity(commit.authors[0], logins, accountTypes))).length,
    contributors: [...people.values()]
      .map((person) => ({
        ...person,
        label: person.login ? `@${person.login}` : person.name.replace(/[^\p{L}\p{N} .'-]/gu, ''),
        first: !firstRelease && !old.has(person.key),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function escapeMarkdown(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_[\]])/g, '\\$1');
}

export function compose({ version, intro, commits, summary, config }) {
  // Validate both places changelogithub/wrapper can credit identities, before producing any output.
  for (const person of [...commits.flatMap((commit) => commit.resolvedAuthors ?? []), ...summary.contributors]) {
    if (!isPerson(person) || (person.login && !/^[a-z\d-]+$/i.test(person.login)))
      throw new Error('Excluded or invalid contributor reached release notes; refusing to emit notes.');
  }
  const safeCommits = commits.map((commit) => ({
    ...commit,
    description: escapeMarkdown(commit.description),
    scope: escapeMarkdown(commit.scope),
    resolvedAuthors: commit.resolvedAuthors?.map((person) => ({ ...person, name: person.name.replace(/[^\p{L}\p{N} .'-]/gu, '') })),
  }));
  let changelog = generateMarkdown(safeCommits, config);
  // There is no compare baseline on the first release. Include the root commit and link its full history.
  if (!config.from) changelog = changelog.replace(`/compare/...${config.to}`, `/commits/${config.to}`);
  return [
    `### Highlights\n\n${intro}`,
    `**${version}** · ${summary.changes} changes from ${summary.contributors.length} contributor${summary.contributors.length === 1 ? '' : 's'}`,
    `<details>\n<summary>Full changelog</summary>\n\n${changelog}\n\n</details>`,
    '### Thank you',
    summary.contributors.map((person) => `- ${person.label}${person.first ? ' (first-time contributor)' : ''}`).join('\n') ||
      'No human contributors in this range.',
  ]
    .join('\n\n')
    .concat('\n');
}

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const git = (...args) => run('git', args).trim();

export function previousTag(to, gitCommand = git) {
  const tags = gitCommand('tag', '--merged', to, '--list', 'v*', '--sort=-version:refname')
    .split('\n')
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  const previous = tags.filter((tag) => gitCommand('rev-parse', `${tag}^{commit}`) !== to);
  return previous.length ? gitCommand('describe', '--tags', '--abbrev=0', ...previous.flatMap((tag) => ['--match', tag]), to) : undefined;
}

export function resolveLogins(commits, repo, gh = (...args) => run('gh', args)) {
  const logins = new Map();
  const [owner, name] = repo.split('/');
  for (let offset = 0; offset < commits.length; offset += 30) {
    const objects = commits
      .slice(offset, offset + 30)
      .map(
        (commit, index) =>
          `c${index}: object(oid: "${commit.shortHash}") { ... on Commit { authors(first: 100) { nodes { email user { login } } pageInfo { hasNextPage } } } }`,
      )
      .join('\n');
    const result = JSON.parse(gh('api', 'graphql', '-f', `query=query { repository(owner: "${owner}", name: "${name}") { ${objects} } }`));
    if (result.errors || !result.data?.repository || Object.keys(result.data.repository).length !== commits.slice(offset, offset + 30).length)
      throw new Error('GitHub identity lookup failed.');
    for (const commit of Object.values(result.data.repository)) {
      if (!commit?.authors?.nodes?.length || commit.authors.pageInfo?.hasNextPage !== false) throw new Error('Incomplete GitHub author lookup.');
      for (const author of commit.authors.nodes) {
        if (typeof author.email !== 'string' || (author.user && typeof author.user.login !== 'string'))
          throw new Error('Incomplete GitHub author lookup.');
        if (author.user) logins.set(author.email.toLowerCase(), author.user.login);
      }
    }
  }
  const accountTypes = new Map();
  for (const login of new Set(logins.values())) {
    const account = JSON.parse(gh('api', `users/${login}`));
    if (!account.type) throw new Error(`Missing GitHub account type for ${login}.`);
    accountTypes.set(login, account.type);
  }
  return { logins, accountTypes };
}

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string', default: 'HEAD' },
      version: { type: 'string' },
      dry: { type: 'boolean' },
      output: { type: 'string' },
      changelog: { type: 'string', default: 'CHANGELOG.md' },
    },
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
  });
  const version = values.version ?? process.env.GITHUB_REF_NAME;
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) throw new Error('Use --version vX.Y.Z.');
  const to = git('rev-parse', '--verify', `${values.to}^{commit}`);
  const from = values.from ?? previousTag(to);
  if (from) git('merge-base', '--is-ancestor', git('rev-parse', '--verify', `${from}^{commit}`), to);
  const repo = git('remote', 'get-url', 'origin')
    .replace(/^.*github.com[:/]/, '')
    .replace(/\.git$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Origin must be a GitHub repository.');
  const intro = highlights(readFileSync(values.changelog, 'utf8'), version);
  // Use only changelogithub's output APIs: never its CLI, sendRelease or uploadAssets.
  const config = await resolveConfig({ dry: true, from: from || to, to: version, repo });
  config.from = from ?? '';
  const readLog = (range) => parseLog(run('git', ['log', '--no-merges', '--format=%H%x1f%an%x1f%ae%x1f%B%x1e', range]), config);
  const commits = readLog(from ? `${from}..${to}` : to);
  const previous = from ? readLog(from) : [];
  const { logins, accountTypes } = resolveLogins([...commits, ...previous], repo);
  const body = compose({
    version,
    intro,
    commits,
    summary: summarize(commits, previous, logins, accountTypes),
    config,
  });
  if (values.output) writeFileSync(values.output, body);
  process.stdout.write(body);
  console.error(`${values.dry ? 'Dry run' : 'Notes generated'}: no release was created or edited.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
