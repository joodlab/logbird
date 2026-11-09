import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const types = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
  build: 'Build',
  chore: 'Maintenance',
  ci: 'CI',
  docs: 'Documentation',
  refactor: 'Refactoring',
  revert: 'Reverts',
  style: 'Style',
  test: 'Tests',
};
const conventional = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/;
const excludedEmail =
  /@openai\.com$|^noreply@(?:anthropic\.com|cursor\.com|githubcopilot\.com)$|^(?:\d+\+)?(?:dependabot|github-actions)(?:\[bot\])?@(?:users\.noreply\.github\.com|github\.com)$/i;

// Reserved documentation/test domains (RFC 2606/6761, e.g. history-scrubbed addresses) never identify a real contributor.
const placeholderEmail = /@(?:[\w-]+\.)*(?:example\.(?:com|net|org)|example|invalid|localhost)$/i;

export function isPerson({ name = '', email = '', login = '', type }) {
  return (
    type !== 'Bot' && !/\[bot\]/i.test(`${name} ${email} ${login}`) && !excludedEmail.test(email) && !placeholderEmail.test(email)
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

export function parseLog(log) {
  return log
    .split('\x1e')
    .filter((record) => record.trim())
    .map((record) => {
      const [sha, name, email, ...parts] = record.trim().split('\x1f');
      const message = parts.join('\x1f');
      const people = [{ name, email }];
      for (const match of message.matchAll(/^Co-authored-by:\s*(.+?)\s*<([^>]+)>\s*$/gim)) people.push({ name: match[1], email: match[2] });
      return { sha, subject: message.split('\n')[0], people };
    });
}

function identity(person, logins, accountTypes) {
  const login = logins.get(person.email.toLowerCase());
  return { ...person, login, type: accountTypes.get(login), key: login?.toLowerCase() ?? person.email.toLowerCase() };
}

export function summarize(commits, previous, logins, accountTypes = new Map()) {
  const peopleFor = (commit) => commit.people.map((person) => identity(person, logins, accountTypes)).filter(isPerson);
  const old = new Set(previous.flatMap(peopleFor).map((person) => person.key));
  const people = new Map(commits.flatMap(peopleFor).map((person) => [person.key, person]));
  // The same human can appear under a GitHub login and as a bare name/email; keep the login entry.
  const loginNames = new Set([...people.values()].filter((person) => person.login).map((person) => person.name.toLowerCase()));
  for (const [key, person] of people) if (!person.login && loginNames.has(person.name.toLowerCase())) people.delete(key);
  // Nobody is a "first-time contributor" in the very first release.
  const firstRelease = previous.length === 0;
  return {
    changes: commits.filter((commit) => isPerson(identity(commit.people[0], logins, accountTypes))).length,
    contributors: [...people.values()]
      .map((person) => ({
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

export function compose({ version, from, to, repo, intro, commits, summary }) {
  const groups = new Map();
  for (const commit of commits) {
    const match = conventional.exec(commit.subject);
    const title = match ? (types[match[1]] ?? 'Other changes') : 'Other changes';
    const subject = match ? `${match[2] ? `${match[2]}: ` : ''}${match[4]}` : commit.subject;
    const pr = subject.match(/\(#(\d+)\)\s*$/);
    const description = escapeMarkdown(subject.replace(/\s*\(#\d+\)\s*$/, '')) + (match?.[3] ? ' (breaking change)' : '');
    const link = pr
      ? `[#${pr[1]}](https://github.com/${repo}/pull/${pr[1]})`
      : `[${commit.sha.slice(0, 7)}](https://github.com/${repo}/commit/${commit.sha})`;
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(`- ${description} (${link})`);
  }
  const changelog = [...Object.values(types), 'Other changes']
    .filter((title) => groups.has(title))
    .map((title) => `### ${title}\n\n${groups.get(title).join('\n')}`)
    .join('\n\n');
  const history = from ? `https://github.com/${repo}/compare/${from}...${to}` : `https://github.com/${repo}/commits/${to}`;
  return [
    `**${version}** · ${summary.changes} changes from ${summary.contributors.length} contributor${summary.contributors.length === 1 ? '' : 's'}`,
    intro,
    `<details>\n<summary>Full changelog</summary>\n\n${changelog || 'No changes in this range.'}\n\n[Full history](${history})\n\n</details>`,
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
  return tags.find((tag) => gitCommand('rev-parse', `${tag}^{commit}`) !== to);
}

export function resolveLogins(commits, repo, gh = (...args) => run('gh', args)) {
  const logins = new Map();
  const [owner, name] = repo.split('/');
  for (let offset = 0; offset < commits.length; offset += 30) {
    const objects = commits
      .slice(offset, offset + 30)
      .map(
        (commit, index) =>
          `c${index}: object(oid: "${commit.sha}") { ... on Commit { authors(first: 100) { nodes { email user { login } } pageInfo { hasNextPage } } } }`,
      )
      .join('\n');
    const result = JSON.parse(gh('api', 'graphql', '-f', `query=query { repository(owner: "${owner}", name: "${name}") { ${objects} } }`));
    if (result.errors || !result.data?.repository) throw new Error('GitHub identity lookup failed.');
    for (const commit of Object.values(result.data.repository)) {
      if (!commit?.authors || commit.authors.pageInfo.hasNextPage) throw new Error('Incomplete GitHub author lookup.');
      for (const author of commit.authors.nodes) if (author.user) logins.set(author.email.toLowerCase(), author.user.login);
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

function main() {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string', default: 'HEAD' },
      version: { type: 'string' },
      dry: { type: 'boolean' },
      output: { type: 'string' },
    },
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
  });
  const version = values.version ?? process.env.GITHUB_REF_NAME;
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) throw new Error('Use --version vX.Y.Z.');
  const to = git('rev-parse', '--verify', `${values.to}^{commit}`);
  const from = values.from ? git('rev-parse', '--verify', `${values.from}^{commit}`) : previousTag(to);
  if (from) git('merge-base', '--is-ancestor', from, to);
  const repo = git('remote', 'get-url', 'origin')
    .replace(/^.*github.com[:/]/, '')
    .replace(/\.git$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Origin must be a GitHub repository.');
  const intro = highlights(readFileSync('CHANGELOG.md', 'utf8'), version);
  const readLog = (range) => parseLog(run('git', ['log', '--no-merges', '--format=%H%x1f%an%x1f%ae%x1f%B%x1e', range]));
  const commits = readLog(from ? `${from}..${to}` : to);
  const previous = from ? readLog(from) : [];
  const { logins, accountTypes } = resolveLogins([...commits, ...previous], repo);
  const body = compose({
    version,
    from: values.from ?? from,
    to: values.to,
    repo,
    intro,
    commits,
    summary: summarize(commits, previous, logins, accountTypes),
  });
  if (values.output) writeFileSync(values.output, body);
  process.stdout.write(body);
  console.error(`${values.dry ? 'Dry run' : 'Notes generated'}: no release was created or edited.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
