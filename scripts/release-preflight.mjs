import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repositoryVersion } from './check-version-consistency.mjs';

const latestQuality = (checks) =>
  checks.filter((check) => check.name === 'Quality' && check.app?.slug === 'github-actions').sort((a, b) => b.id - a.id)[0];

export function requireQuality(checks, run, sha) {
  const quality = latestQuality(checks);
  if (!quality || quality.head_sha !== sha || quality.status !== 'completed' || quality.conclusion !== 'success') {
    throw new Error('The latest GitHub Actions Quality check must pass on the exact release commit.');
  }
  if (
    run.check_suite_id !== quality.check_suite?.id ||
    run.head_sha !== sha ||
    run.path !== '.github/workflows/ci.yml' ||
    run.head_branch !== 'master' ||
    run.event !== 'push' ||
    run.conclusion !== 'success'
  ) {
    throw new Error('Quality must belong to successful ci.yml CI on master.');
  }
  return quality;
}

function main() {
  const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
  const git = (...args) => run('git', args);
  const repo = process.env.GITHUB_REPOSITORY;
  const tag = process.env.GITHUB_REF_NAME;
  const version = repositoryVersion(tag);
  if (!repo || !tag) throw new Error('Release preflight requires GitHub tag context.');
  const sha = git('rev-parse', 'HEAD');
  if (git('rev-parse', `${tag}^{commit}`) !== sha) throw new Error('Checkout must match the tag commit.');
  git('fetch', 'origin', 'master');
  git('merge-base', '--is-ancestor', sha, 'origin/master');
  const pages = JSON.parse(
    run('gh', ['api', '--paginate', '--slurp', `repos/${repo}/commits/${sha}/check-runs?check_name=Quality&filter=latest&per_page=100`]),
  );
  const checks = pages.flatMap((page) => page.check_runs);
  const quality = latestQuality(checks);
  const runId = quality?.details_url?.match(/\/actions\/runs\/(\d+)\//)?.[1];
  if (!runId) throw new Error('Missing Quality workflow run.');
  const workflow = JSON.parse(run('gh', ['api', `repos/${repo}/actions/runs/${runId}`]));
  requireQuality(checks, workflow, sha);
  const releases = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])).flat();
  if (releases.some((release) => release.tag_name === tag))
    throw new Error('This version already has a release; refusing to rebuild published images.');
  console.log(`Preflight passed: ${version} at ${sha}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
