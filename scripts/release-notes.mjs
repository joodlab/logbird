import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { generateMarkdown, parseCommits, resolveConfig } from 'changelogithub';

// AI coding agents and automation sign commits with these addresses; GitHub can map some of them to real
// accounts (e.g. codex@users.noreply.github.com resolves to @codex), so match the address, not the login.
// Whole vendor domains (and their subdomains) are excluded because agents sign with several addresses there.
const agentDomain =
  /@(?:[\w-]+\.)*(?:openai\.com|anthropic\.com|cursor\.com|githubcopilot\.com|aider\.chat|ampcode\.com|all-hands\.dev|codeium\.com|windsurf\.com|augmentcode\.com)$/i;
// Agent accounts on any domain (e.g. a team's claude@ or codex@ mailbox), and GitHub's bot/agent noreply addresses.
const agentAddress =
  /^(?:\d+\+)?(?:claude|codex|copilot|cursor|cursoragent|aider|amp|openhands|windsurf|devin-ai-integration|gemini-code-assist|google-labs-jules)(?:[-_](?:code|agent|ai|bot|cli))?(?:\[bot\])?@|^(?:\d+\+)?(?:dependabot|github-actions)(?:\[bot\])?@(?:users\.noreply\.github\.com|github\.com)$|^(?:gemini|jules)[\w.+-]*@google\.com$/i;
const excludedLogin = /^(?:codex|claude|copilot|cursor(?:agent)?|devin-ai-integration|gemini-code-assist|google-labs-jules|amp|openhands)$/i;
// Agent display names, alone or with a product/model suffix ("Claude Opus 5.5", "Cursor Agent", "Gemini CLI"). A person
// whose git name happens to be "Claude" still gets credit once GitHub resolves them to a User account.
const excludedName =
  /^(?:claude|codex|copilot|cursor|devin|gemini|jules|aider|amp|openhands|windsurf|augment)(?:[ -](?:code|agent|cli|ai|bot|assistant|opus|sonnet|haiku|\d[\w.]*))*$/i;

// Reserved documentation/test domains (RFC 2606/6761, e.g. history-scrubbed addresses) never identify a real contributor.
const placeholderEmail = /@(?:[\w-]+\.)*(?:example\.(?:com|net|org)|example|invalid|localhost|test)$/i;

export function isPerson({ name = '', email = '', login = '', type }) {
  return (
    type !== 'Bot' &&
    !/\[bot\]/i.test(`${name} ${email} ${login}`) &&
    !agentDomain.test(email) &&
    !agentAddress.test(email) &&
    !excludedLogin.test(login) &&
    !(excludedName.test(name.trim()) && !(login && type === 'User')) &&
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

const conventional = /^([a-z]+)(?:\(([^)]+)\))?(!)?: (.+)$/i;
const breakingFooter = /^BREAKING[ -]CHANGE:/m;
const coAuthorValue = /^(.+?)[ \t]*<[ \t]*([^>\n]+?)[ \t]*>[ \t]*$/;

/**
 * The `git log` format parseLog reads. Git itself parses the trailer block (`%(trailers)`, the same rules as
 * `git interpret-trailers`), so a co-author named in prose, a fenced example or above a `---` divider is never
 * credited, and one after `(cherry picked from commit …)` or among `Signed-off-by:` lines is. Identities stay raw
 * here; applyMailmap() then maps authors and co-authors alike through the repository's `.mailmap`.
 */
export const LOG_FORMAT = '%H%x1f%an%x1f%ae%x1f%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x1d)%x1f%B%x1e';

/** The message's final paragraph, where Conventional Commits footers such as `BREAKING CHANGE:` live. */
const lastParagraph = (body) =>
  body
    .trim()
    .split(/\n[ \t]*\n/)
    .at(-1) ?? '';

// changelogen and changelogithub look scopes up in plain objects, so `constructor` or `__proto__` would resolve to an
// Object.prototype member and crash rendering. Such scopes move into the description instead.
const prototypeKey = (key) => key in Object.prototype;

/**
 * Parses `git log` records with our own subject and trailer rules, and hands changelogen only `type!: description`
 * (it still extracts PR and commit references). Its greedy scope regex, Object-backed scope lookups and unanchored
 * co-author regex never see the raw message. Unknown and non-conventional subjects stay whole under Other changes.
 */
export function parseLog(log, config) {
  return log
    .split('\x1e')
    .filter((record) => record.trim())
    .map((record) => {
      const [sha, rawName, rawEmail, coAuthorField = '', ...parts] = record.trim().split('\x1f');
      // Identities are compared trimmed, so padding never slips an address past the exclusion rules.
      const [name, email] = [rawName.trim(), rawEmail.trim()];
      const [message, ...lines] = parts.join('\x1f').replace(/\r\n?/g, '\n').split('\n');
      const body = lines.join('\n');
      const match = message.match(conventional);
      const type = match?.[1].toLowerCase();
      const known = Boolean(type && type !== 'other' && Object.hasOwn(config.types, type));
      const scope = known ? (match?.[2]?.trim() ?? '') : '';
      const subject = known ? `${type}${match?.[3] ?? ''}: ${match?.[4]}` : `other: ${message}`;
      const [commit] = parseCommits([{ shortHash: sha, message: subject, body, author: { name, email } }], config);
      if (!commit || commit.type !== (known ? type : 'other')) throw new Error(`Could not parse commit ${sha}.`);
      commit.scope = prototypeKey(scope) ? '' : scope;
      if (scope && prototypeKey(scope)) commit.description = `${scope}: ${commit.description}`;
      const coAuthors = coAuthorField
        .split('\x1d')
        .map((value) => value.trim().match(coAuthorValue))
        .filter(Boolean)
        .map(([, coName, coEmail]) => ({ name: coName.trim(), email: coEmail.trim() }));
      commit.authors = [{ name, email }, ...coAuthors];
      // `!` marks a breaking change whatever the type (an unknown type keeps it under Other changes), and so does a
      // Conventional Commits `BREAKING CHANGE:` footer.
      if (match?.[3] || breakingFooter.test(lastParagraph(body))) commit.isBreaking = true;
      return commit;
    });
}

// GitHub reports the address a commit was made with; logins are found by that raw address or the .mailmap one.
function identity(person, logins, accountTypes) {
  const login = logins.get(person.email.toLowerCase()) ?? (person.rawEmail && logins.get(person.rawEmail.toLowerCase()));
  return { ...person, login, type: accountTypes.get(login), key: login?.toLowerCase() ?? person.email.toLowerCase() };
}

// Both the identity as committed and its .mailmap identity must pass: a mailmap line can't turn an agent mailbox's
// work into a human's credit.
const credited = (person) =>
  isPerson(person) && (person.rawEmail === undefined || isPerson({ ...person, name: person.rawName, email: person.rawEmail }));

// Display names keep letters, digits and a little punctuation; nothing that markdown or HTML could interpret.
const safeName = (name) => name.replace(/[^\p{L}\p{N} .'-]/gu, '').trim();

export function summarize(commits, previous, logins, accountTypes = new Map()) {
  // An unresolved identity whose name sanitizes to nothing can't be credited legibly, so it isn't credited.
  const peopleFor = (commit) =>
    commit.authors
      .map((person) => identity(person, logins, accountTypes))
      .filter((person) => credited(person) && (person.login || safeName(person.name)));
  // Identities merge only by verified GitHub login (several emails, one account) or by the repository's .mailmap,
  // never by display name: two people can share one. Inline credits and Thank you use the same keys.
  const unique = (people) => [...new Map(people.map((person) => [person.key, person])).values()];
  const creditsFor = (commit) => unique(peopleFor(commit));
  for (const commit of commits) commit.resolvedAuthors = creditsFor(commit);
  const old = new Set(previous.flatMap(creditsFor).map((person) => person.key));
  const people = new Map(commits.flatMap(creditsFor).map((person) => [person.key, person]));
  // Nobody is a "first-time contributor" in the very first release.
  const firstRelease = previous.length === 0;
  return {
    // A change counts when its author is credited, by the same rule as the credits themselves.
    changes: commits.filter((commit) => {
      const author = identity(commit.authors[0], logins, accountTypes);
      return credited(author) && (author.login || safeName(author.name));
    }).length,
    contributors: [...people.values()]
      .map((person) => ({
        ...person,
        label: person.login ? `@${person.login}` : safeName(person.name),
        first: !firstRelease && !old.has(person.key),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function escapeMarkdown(text) {
  return (
    text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replace(/([\\`*_[\]])/g, '\\$1')
      // A zero-width space after @ keeps subjects like "thanks @codex" or "bump @types/node" from mentioning accounts.
      .replaceAll('@', '@\u200b')
  );
}

export function compose({ version, intro, commits, summary, config }) {
  // Validate both places changelogithub/wrapper can credit identities, before producing any output.
  for (const person of [...commits.flatMap((commit) => commit.resolvedAuthors ?? []), ...summary.contributors]) {
    if (!credited(person) || (person.login ? !/^[a-z\d-]+$/i.test(person.login) : !safeName(person.name)))
      throw new Error('Excluded or invalid contributor reached release notes; refusing to emit notes.');
  }
  const safeCommits = commits.map((commit) => ({
    ...commit,
    description: escapeMarkdown(commit.description),
    scope: escapeMarkdown(commit.scope),
    resolvedAuthors: commit.resolvedAuthors?.map((person) => ({ ...person, name: safeName(person.name) })),
  }));
  let changelog = generateMarkdown(safeCommits, config);
  // There is no compare baseline on the first release. Include the root commit and link its full history.
  if (!config.from) changelog = changelog.replace(`/compare/...${config.to}`, `/commits/${config.to}`);
  return [
    `### Highlights\n\n${intro}`,
    `**${version}** · ${summary.changes} change${summary.changes === 1 ? '' : 's'} from ${summary.contributors.length} contributor${summary.contributors.length === 1 ? '' : 's'}`,
    `<details>\n<summary>Full changelog</summary>\n\n${changelog}\n\n</details>`,
    '### Thank you',
    summary.contributors.map((person) => `- ${person.label}${person.first ? ' (first-time contributor)' : ''}`).join('\n') ||
      'No human contributors in this range.',
  ]
    .join('\n\n')
    .concat('\n');
}

/**
 * Maps every author and co-author through the repository's .mailmap, the explicit alias list for a person who
 * commits under several addresses, keeping the identity as committed in `rawName`/`rawEmail`. `check` takes
 * `Name <email>` contacts and returns one mapped contact per line (`git check-mailmap --stdin`, so names beginning
 * with `-` and long batches are safe).
 */
export function applyMailmap(commits, check = (contacts) => run('git', ['check-mailmap', '--stdin'], `${contacts.join('\n')}\n`)) {
  const contact = (person) => `${person.name} <${person.email}>`;
  const contacts = [...new Set(commits.flatMap((commit) => commit.authors.map(contact)))];
  const mapped = new Map();
  if (contacts.length) {
    const lines = check(contacts).split('\n').filter(Boolean);
    if (lines.length !== contacts.length) throw new Error('git check-mailmap returned an unexpected number of identities.');
    for (const [index, value] of contacts.entries()) mapped.set(value, lines[index]);
  }
  for (const commit of commits) {
    commit.authors = commit.authors.map((person) => {
      const [, name, email] = mapped.get(contact(person))?.match(/^(.*?)\s*<([^>]*)>$/) ?? [];
      if (name === undefined) throw new Error(`git check-mailmap returned no identity for ${contact(person)}.`);
      return { name: name.trim(), email: email.trim(), rawName: person.name, rawEmail: person.email };
    });
  }
  return commits;
}

const run = (command, args, input) => execFileSync(command, args, { encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
const git = (...args) => run('git', args).trim();

export function previousTag(to, gitCommand = git) {
  const tags = gitCommand('tag', '--merged', to, '--list', 'v*', '--sort=-version:refname')
    .split('\n')
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  const previous = tags.filter((tag) => gitCommand('rev-parse', `${tag}^{commit}`) !== to);
  return previous.length ? gitCommand('describe', '--tags', '--abbrev=0', ...previous.flatMap((tag) => ['--match', tag]), to) : undefined;
}

export function resolveLogins(allCommits, repo, gh = (...args) => run('gh', args)) {
  const logins = new Map();
  const [owner, name] = repo.split('/');
  // One commit per new address as committed is enough: GitHub maps an address to the same account on every commit.
  // Its answer is keyed by that raw address, and also by the address's .mailmap identity.
  const seen = new Set();
  const mailmapped = new Map(
    allCommits.flatMap((commit) =>
      commit.authors.filter((person) => person.rawEmail).map((person) => [person.rawEmail.toLowerCase(), person.email.toLowerCase()]),
    ),
  );
  const commits = allCommits.filter((commit) => {
    const fresh = commit.authors.map((person) => (person.rawEmail ?? person.email).toLowerCase()).filter((email) => !seen.has(email));
    for (const email of fresh) seen.add(email);
    return fresh.length > 0;
  });
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
        if (author.user) {
          logins.set(author.email.toLowerCase(), author.user.login);
          const canonical = mailmapped.get(author.email.toLowerCase());
          if (canonical && !logins.has(canonical)) logins.set(canonical, author.user.login);
        }
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
      changelog: { type: 'string' },
    },
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
  });
  // Explicit paths are relative to where the command runs; then work from the repository root, where changelogithub
  // loads changelogithub.config.ts and where the default CHANGELOG.md lives.
  const changelogArgument = values.changelog && resolve(values.changelog);
  const outputPath = values.output && resolve(values.output);
  process.chdir(git('rev-parse', '--show-toplevel'));
  const changelogPath = changelogArgument ?? resolve('CHANGELOG.md');
  const version = values.version ?? process.env.GITHUB_REF_NAME;
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) throw new Error('Use --version vX.Y.Z.');
  const to = git('rev-parse', '--verify', `${values.to}^{commit}`);
  const from = values.from ?? previousTag(to);
  if (from) git('merge-base', '--is-ancestor', git('rev-parse', '--verify', `${from}^{commit}`), to);
  const repo = git('remote', 'get-url', 'origin')
    .replace(/^.*github.com[:/]/, '')
    .replace(/\.git$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Origin must be a GitHub repository.');
  const intro = highlights(readFileSync(changelogPath, 'utf8'), version);
  // Use only changelogithub's output APIs: never its CLI, sendRelease or uploadAssets.
  const config = await resolveConfig({ dry: true, from: from || to, to: version, repo });
  config.from = from ?? '';
  const readLog = (range) => applyMailmap(parseLog(run('git', ['log', '--no-merges', `--format=${LOG_FORMAT}`, range]), config));
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
  if (outputPath) writeFileSync(outputPath, body);
  process.stdout.write(body);
  console.error(`${values.dry ? 'Dry run' : 'Notes generated'}: no release was created or edited.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
