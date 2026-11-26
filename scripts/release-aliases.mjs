#!/usr/bin/env node
// Which moving aliases a release may take, so a late or re-run release never moves one backwards.
//
//   node scripts/release-aliases.mjs <X.Y.Z> <releases.json> [--require-own]
//   node scripts/release-aliases.mjs published <vX.Y.Z> <releases.json>
//
// <releases.json> is `gh api --paginate --slurp repos/<repo>/releases?per_page=100`: an array of pages, each an array of
// release objects. Anything else (a page that is not an array, a release without a string tag_name, or with a draft or
// prerelease that is not a boolean) is refused, so a malformed response can never read as "no release". The `published`
// form prints `published=<count>`: how many published (not draft) releases the tag has. Only
// published stable releases count: drafts, prereleases and tags that are not vX.Y.Z are ignored. Prints, in the
// GITHUB_OUTPUT format:
//   minor=true|false   the image alias X.Y may move to this version (no published X.Y.N is newer)
//   latest=true|false  the image alias `latest` and the GitHub "Latest release" mark may move (no published release is
//                      newer)
// --require-own fails unless this version's own release is already published: aliases follow the release, never lead.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const parse = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`not a stable X.Y.Z version: ${JSON.stringify(version)}`);
  return match.slice(1).map(Number);
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The releases of a slurped, paginated response, after checking its shape; throws on anything else. */
export function releasesOf(pages) {
  if (!Array.isArray(pages)) throw new Error('the releases response is not an array of pages');
  return pages.flatMap((page, index) => {
    if (!Array.isArray(page)) throw new Error(`releases page ${index} is not an array`);
    for (const release of page) {
      if (release === null || typeof release !== 'object' || Array.isArray(release)) throw new Error(`releases page ${index} holds a non-object`);
      if (typeof release.tag_name !== 'string') throw new Error(`a release has no string tag_name: ${JSON.stringify(release.tag_name)}`);
      if (typeof release.draft !== 'boolean')
        throw new Error(`release ${release.tag_name} has a non-boolean draft: ${JSON.stringify(release.draft)}`);
      if (release.prerelease !== undefined && typeof release.prerelease !== 'boolean')
        throw new Error(`release ${release.tag_name} has a non-boolean prerelease: ${JSON.stringify(release.prerelease)}`);
    }
    return page;
  });
}

/** How many published (not draft) releases the tag has. */
export function publishedCount(pages, tag) {
  return releasesOf(pages).filter((release) => release.tag_name === tag && release.draft === false).length;
}

/** The stable versions of the published (not draft, not prerelease) vX.Y.Z releases. */
export function publishedVersions(pages) {
  return releasesOf(pages)
    .filter((release) => release.draft === false && release.prerelease !== true && /^v\d+\.\d+\.\d+$/.test(release.tag_name))
    .map((release) => release.tag_name.slice(1));
}

export function allowedAliases(version, published, { requireOwn = false } = {}) {
  const own = parse(version);
  if (requireOwn && !published.includes(version)) throw new Error(`the release v${version} is not published; aliases move only after it`);
  const others = published.filter((v) => v !== version).map(parse);
  return {
    minor: !others.some((v) => v[0] === own[0] && v[1] === own[1] && compare(v, own) > 0),
    latest: !others.some((v) => compare(v, own) > 0),
  };
}

function main(version, file, ...flags) {
  if (version === 'published') {
    const [tag, releasesFile] = [file, flags[0]];
    if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '') || !releasesFile) throw new Error('usage: published <vX.Y.Z> <releases.json>');
    console.log(`published=${publishedCount(JSON.parse(readFileSync(releasesFile, 'utf8')), tag)}`);
    return;
  }
  if (!version || !file) {
    console.error('usage: node scripts/release-aliases.mjs <X.Y.Z> <releases.json> [--require-own]');
    process.exit(2);
  }
  const published = publishedVersions(JSON.parse(readFileSync(file, 'utf8')));
  const { minor, latest } = allowedAliases(version, published, { requireOwn: flags.includes('--require-own') });
  console.log(`minor=${minor}`);
  console.log(`latest=${latest}`);
  if (!minor || !latest)
    console.error(
      `A newer release is published; ${version} leaves ${[!minor && 'X.Y', !latest && 'latest'].filter(Boolean).join(' and ')} where they are.`,
    );
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(...process.argv.slice(2));
  } catch (error) {
    console.error(`release aliases: ${error.message}`);
    process.exit(1);
  }
}
