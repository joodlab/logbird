#!/usr/bin/env node
// The release install check (README.md): installs the released tarballs the way docs/integrating-a-backend.md and the
// SDK README tell a user to, from a local stand-in for the GitHub Release download URL, into a fresh application outside
// this repository. From the repository root:
//
//   node tests/npm-release-install/run.mjs --packages=<folder> [--manager=pnpm|npm] [--source=file|url] [--shape=sdk|hono]
//   node tests/npm-release-install/run.mjs --packages=<folder> --workspace
//
// <folder> holds the release asset set (scripts/npm-release-assets.mjs pack writes it). Without the filters it runs every
// combination. Shapes: `sdk` installs @logbird/sdk alone (no override); `hono` installs @logbird/sdk and @logbird/hono
// with the override that points the integration's own @logbird/sdk dependency at the same tarball. Each combination:
// 1. "downloads" the assets over HTTP from the stand-in (which redirects, as GitHub does) and, for --source=file,
//    verifies them against SHA256SUMS the way the docs do (`grep … SHA256SUMS | sha256sum --check` where it exists);
// 2. installs: shape `sdk` runs the documented command (`pnpm add <file or URL>`, `npm install <file or URL>`); shape
//    `hono` writes the documented package.json and override (pnpm: pnpm-workspace.yaml; npm: package.json) and installs;
// 3. requires the lockfile to pin each released tarball with the sha512 integrity of the released file and to hold a
//    single @logbird/sdk (for `hono`, also the copy @logbird/hono resolves at run time), and every registry package to be
//    exactly the pinned one (below);
// 4. deletes node_modules and the package cache and installs again with a frozen lockfile (`pnpm install
//    --frozen-lockfile`, `npm ci`), fetching the tarballs again;
// 5. type-checks, compiles and runs a consumer under TypeScript 6 (strict, skipLibCheck false): `hono` runs
//    tests/npm-consumer/src/main.ts, `sdk` runs src/sdk-only.ts;
// 6. replaces the released SDK tarball with other bytes and requires a frozen install with an empty cache to refuse it.
//
// Nothing here resolves an unpinned version: the application's registry packages (hono, TypeScript 6, @types/node and
// its one dependency, undici-types) are pinned to exact versions, undici-types through an override at the version
// tests/npm-consumer/package-lock.json locks. That pin belongs to this test application, not to the documented recipe;
// it keeps the check deterministic, so the release workflow can run it.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseSums, SUMS, tarballName, verifyAssets } from '../../scripts/npm-release-assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const isWindows = process.platform === 'win32';

const packagesArg = option('packages');
if (!packagesArg) throw new Error('pass --packages=<folder with the release asset set>');
const packages = realpathSync(packagesArg);
const sdkFile = readdirSync(packages).find((file) => /^logbird-sdk-\d+\.\d+\.\d+\.tgz$/.test(file));
if (!sdkFile) throw new Error(`${packages} holds no logbird-sdk-<version>.tgz`);
const version = /^logbird-sdk-(.+)\.tgz$/.exec(sdkFile)[1];
// The whole asset set, exactly as the release attaches it.
verifyAssets(packages, version);

// The pinned registry packages. hono and @types/node follow tests/npm-consumer; TypeScript 6 is installed under its own
// name, as a TypeScript 6 application has it. None has dependencies except @types/node (undici-types).
const consumerManifest = JSON.parse(readFileSync(join(repo, 'tests', 'npm-consumer', 'package.json'), 'utf8'));
const consumerLock = JSON.parse(readFileSync(join(repo, 'tests', 'npm-consumer', 'package-lock.json'), 'utf8'));
const locked = (name) => {
  const found = consumerLock.packages[`node_modules/${name}`]?.version;
  if (!found) throw new Error(`tests/npm-consumer/package-lock.json locks no ${name}`);
  return found;
};
const HONO = consumerManifest.devDependencies.hono;
const TYPES_NODE = consumerManifest.devDependencies['@types/node'];
if (locked('@types/node') !== TYPES_NODE) throw new Error('tests/npm-consumer: @types/node in package.json and package-lock.json differ');
const PINNED_OVERRIDES = { 'undici-types': locked('undici-types') };
const DEV = { typescript: '6.0.3', '@types/node': TYPES_NODE };

const SHAPES = {
  sdk: {
    released: ['@logbird/sdk'],
    registry: {},
    program: join(here, 'src', 'sdk-only.ts'),
    passed: /sdk-only consumer: all \d+ checks passed/,
  },
  hono: {
    released: ['@logbird/sdk', '@logbird/hono'],
    registry: { hono: HONO },
    program: join(repo, 'tests', 'npm-consumer', 'src', 'main.ts'),
    passed: /npm consumer: all \d+ checks passed/,
  },
};

const pick = (name, all) => {
  const value = option(name);
  if (value && !all.includes(value)) throw new Error(`unknown --${name}=${value}; use ${all.join(' or ')}`);
  return value ? [value] : all;
};
const managers = pick('manager', ['pnpm', 'npm']);
const sources = pick('source', ['file', 'url']);
const shapes = pick('shape', ['sdk', 'hono']);
const workspaceOnly = args.includes('--workspace');
if (workspaceOnly && ['manager', 'source', 'shape'].some(option)) throw new Error('--workspace runs the pnpm 11 workspace cases without filters');

// Through cmd (pnpm and npm are .cmd shims on Windows), an argument with a space or metacharacter must be quoted.
// A % is refused outright: cmd expands %VAR% even inside quotes, and no quoting prevents it.
const quote = (arg) => {
  if (arg.includes('%')) throw new Error(`cannot pass an argument containing % through cmd safely: ${arg}`);
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;
};
// Asynchronous, so the stand-in server below (in this process) keeps answering while a package manager runs.
function exec(command, commandArgs, cwd, capture, env) {
  const shell = isWindows && command !== process.execPath;
  const child = spawn(command, shell ? commandArgs.map(quote) : commandArgs, {
    cwd,
    env,
    shell,
    stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk;
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, output }));
  });
}
async function run(command, commandArgs, cwd, { capture = false, env } = {}) {
  console.log(`$ ${command} ${commandArgs.join(' ')}`);
  const { status, output } = await exec(command, commandArgs, cwd, capture, env);
  if (capture) process.stdout.write(output);
  if (status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} exited with ${status}`);
  return output;
}
async function attempt(command, commandArgs, cwd) {
  console.log(`$ ${command} ${commandArgs.join(' ')}   (expected to fail)`);
  const result = await exec(command, commandArgs, cwd, true);
  process.stdout.write(result.output);
  return result;
}
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const check = (condition, message) => {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
};

/**
 * Every package a lockfile resolved from the registry, as name → the versions it holds, joined with "|" (so a second,
 * nested copy at another version shows instead of hiding behind the first). The released tarballs are left out.
 */
function registryPackages(manager, lock) {
  const found = {};
  const add = (name, version) => {
    found[name] = [...new Set([...(found[name]?.split('|') ?? []), version])].sort().join('|');
  };
  if (manager === 'npm') {
    for (const [key, entry] of Object.entries(JSON.parse(lock).packages)) {
      if (!key) continue;
      const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      if (!name.startsWith('@logbird/')) add(name, entry.version);
    }
    return found;
  }
  const section = lock.split(/^packages:$/m)[1]?.split(/^\S/m)[0] ?? '';
  for (const match of section.matchAll(/^ {2}'?((?:@[^/'\s]+\/)?[^@'\s]+)@([^':\s]+)'?:\s*$/gm)) {
    if (!match[1].startsWith('@logbird/')) add(match[1], match[2]);
  }
  return found;
}

// The stand-in for https://github.com/joodlab/logbird/releases/download/v<version>/<asset>: like GitHub, it answers with
// a redirect to another origin (here a second loopback server, on another port) that serves the file. The asset server
// can serve other bytes in place of an asset (step 6).
const served = new Map(readdirSync(packages).map((file) => [file, readFileSync(join(packages, file))]));
const downloadPath = `/joodlab/logbird/releases/download/v${version}/`;
let requests = 0;
const assets = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://assets');
  const file = url.pathname.startsWith('/release-assets/') ? url.pathname.slice('/release-assets/'.length) : '';
  if (served.has(file)) {
    requests += 1;
    response.setHeader('content-type', 'application/octet-stream');
    response.end(served.get(file));
    return;
  }
  response.statusCode = 404;
  response.end();
});
assets.listen(0, '127.0.0.1');
await once(assets, 'listening');
const assetOrigin = `http://127.0.0.1:${assets.address().port}`;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://stand-in');
  if (url.pathname.startsWith(downloadPath) && served.has(url.pathname.slice(downloadPath.length))) {
    response.statusCode = 302;
    response.setHeader('location', `${assetOrigin}/release-assets/${url.pathname.slice(downloadPath.length)}`);
    response.end();
    return;
  }
  response.statusCode = 404;
  response.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const releaseUrl = `http://127.0.0.1:${server.address().port}${downloadPath}`;

const workspaceAppPath = 'packages/app';
const workspaceApp = { name: 'fixture-app', private: true };
const writeManifest = (dir, manifest) => writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

function writeWorkspace(dir, packageManager, { settings = '', siblingDependencies } = {}) {
  const appDir = join(dir, workspaceAppPath);
  const siblingDir = join(dir, 'packages', 'sibling');
  mkdirSync(appDir, { recursive: true });
  mkdirSync(siblingDir);
  writeManifest(dir, { name: 'release-workspace', private: true, packageManager });
  writeManifest(appDir, workspaceApp);
  writeManifest(siblingDir, { name: 'fixture-sibling', private: true, dependencies: siblingDependencies });
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), `packages:\n  - packages/*\n${settings}`);
  return appDir;
}

function removeWorkspaceModules(dir) {
  for (const project of [dir, join(dir, workspaceAppPath), join(dir, 'packages', 'sibling')]) {
    rmSync(join(project, 'node_modules'), { recursive: true, force: true });
  }
}

function withoutSdkEntries(lock, url) {
  const key = `  '@logbird/sdk@${url}':`;
  const pkgStart = lock.indexOf(`${key}\n`);
  const pkgEnd = lock.indexOf('\n\n', pkgStart);
  if (pkgStart < 0 || pkgEnd <= pkgStart) throw new Error('could not isolate the SDK package entry');
  const app = `  ${workspaceAppPath}:`;
  const importer = `${app}\n    dependencies:\n      '@logbird/sdk':\n        specifier: ${url}\n        version: ${url}\n`;
  return `${lock.slice(0, pkgStart)}${lock.slice(pkgEnd + 2)}`.replace(importer, `${app} {}\n`).replace(`${key} {}\n\n`, '');
}

async function checkHoistedWorkspace(work, packageManager, url, expectedIntegrity) {
  // Keep a real, unrelated entry in the lockfile so the targeted deletion must preserve it.
  const siblingDependencies = { picocolors: '1.1.1' };
  const pinned = 'sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==';
  // Match interactive `pnpm install` semantics even on a CI runner, where plain install defaults to frozen.
  const env = { ...process.env, CI: 'false' };
  const additions = [
    ['linker', 'nodeLinker: hoisted\n'],
    ['overrides', 'overrides:\n  picocolors: 1.1.1\n'],
    ['patch', "patchedDependencies:\n  'picocolors@1.1.1': picocolors.patch\n"],
    ['allowBuilds', 'allowBuilds:\n  picocolors: false\n'],
  ];
  const passed = [];
  let settings = '';
  for (const [stage, addition] of additions) {
    settings += addition;
    const base = join(work, `hoisted-${stage}`);
    const seed = join(base, 'seed');
    writeWorkspace(seed, packageManager, { settings, siblingDependencies });
    const patched = settings.includes('patchedDependencies:');
    if (patched) copyFileSync(join(here, 'pnpm11', 'picocolors.patch'), join(seed, 'picocolors.patch'));
    const lockPath = (dir) => join(dir, 'pnpm-lock.yaml');
    const runPnpm = (dir, command, store) => run('pnpm', [...command, '--store-dir', join(base, store)], dir, { env });
    console.log(`\n== ${packageManager} workspace: hoisted settings through ${stage}`);
    await runPnpm(seed, ['install', '--lockfile-only'], 'seed-store');
    const seedLock = readFileSync(lockPath(seed), 'utf8');
    check(
      Object.keys(registryPackages('pnpm', seedLock)).length === 1 && seedLock.includes(`picocolors@1.1.1:\n    resolution: {integrity: ${pinned}}`),
      'the only registry package is picocolors pinned by version and SHA-512',
    );
    const newCase = (name, specifier = url) => {
      const dir = join(base, name);
      cpSync(seed, dir, { recursive: true });
      if (specifier) writeManifest(join(dir, workspaceAppPath), { ...workspaceApp, dependencies: { '@logbird/sdk': specifier } });
      return dir;
    };
    const checkUrlLock = (dir, label) => {
      const lock = readFileSync(lockPath(dir), 'utf8');
      check(lock.includes(`resolution: {integrity: ${expectedIntegrity}, tarball: ${url}}`), `${label} records the SDK URL and its SHA-512`);
      check(withoutSdkEntries(lock, url) === seedLock, `${label} left the unrelated lockfile entries unchanged`);
      return lock;
    };
    const reinstall = async (dir, label) => {
      const lock = readFileSync(lockPath(dir), 'utf8');
      removeWorkspaceModules(dir);
      await runPnpm(dir, ['install', '--frozen-lockfile'], `${label}-frozen-store`);
      check(existsSync(join(dir, 'node_modules', '@logbird', 'sdk', 'package.json')), `${label} installed the SDK into the hoisted node_modules`);
      if (patched) {
        const readme = readFileSync(join(dir, 'node_modules', 'picocolors', 'README.md'), 'utf8');
        check(readme.startsWith('# picocolors fixture\n'), `${label} applied the unrelated package patch`);
      }
      check(readFileSync(lockPath(dir), 'utf8') === lock, `${label} frozen install left the lockfile unchanged`);
    };

    const lockOnly = newCase('lockfile-only');
    await runPnpm(lockOnly, ['install', '--lockfile-only'], 'lock-only-store');
    checkUrlLock(lockOnly, 'a: lockfile-only');
    await runPnpm(lockOnly, ['install'], 'lock-only-store');
    checkUrlLock(lockOnly, 'a: subsequent plain install');
    await reinstall(lockOnly, 'a');

    const plain = newCase('plain');
    await runPnpm(plain, ['install'], 'plain-store');
    const afterPlain = checkUrlLock(plain, 'b: plain install with a pre-SDK lockfile');
    await runPnpm(plain, ['install', '--fix-lockfile'], 'plain-store');
    const afterFix = checkUrlLock(plain, 'c: fix-lockfile after plain install');
    check(afterFix === afterPlain, 'c: fix-lockfile left the successful plain install lockfile unchanged');
    await reinstall(plain, 'b-c');

    const removed = newCase('removed-sdk');
    writeFileSync(lockPath(removed), withoutSdkEntries(afterFix, url));
    await runPnpm(removed, ['install', '--frozen-lockfile=false'], 'removed-store');
    checkUrlLock(removed, 'd: re-resolution after removing only the SDK entries');
    await reinstall(removed, 'd');

    const filtered = newCase('filtered', null);
    const before = requests;
    await runPnpm(filtered, ['--filter', workspaceApp.name, 'add', url], 'filtered-store');
    check(requests > before, 'filtered add downloaded the SDK tarball');
    checkUrlLock(filtered, 'filtered add');
    await reinstall(filtered, 'filtered');
    passed.push(`${packageManager} workspace: hoisted through ${stage}`);
  }
  return passed;
}

async function checkPnpmWorkspace(work) {
  const { packageManager } = JSON.parse(readFileSync(join(here, 'pnpm11', 'package.json'), 'utf8'));
  const workspaceVersion = (await run('pnpm', ['--version'], work, { capture: true })).trim();
  check(packageManager === `pnpm@${workspaceVersion}`, `workspace check uses the pinned ${packageManager}`);
  const url = `${releaseUrl}${sdkFile}`;
  const expectedIntegrity = integrity(served.get(sdkFile));
  const cases = [
    { name: 'app-file', specifier: `file:vendor/logbird/${sdkFile}`, assetDir: workspaceAppPath },
    { name: 'root-file', specifier: `file:../../vendor/logbird/${sdkFile}`, assetDir: '.' },
    { name: 'workspace-url', specifier: url },
    { name: 'filtered-url', specifier: url },
  ];
  const passed = [];
  for (const { name, specifier, assetDir } of cases) {
    console.log(`\n== pnpm ${workspaceVersion} workspace: ${name}`);
    const dir = join(work, name);
    const appDir = writeWorkspace(dir, packageManager);
    const lockfile = join(dir, 'pnpm-lock.yaml');
    const resolveLockfile = ['install', '--lockfile-only', '--no-frozen-lockfile', '--store-dir', join(work, `${name}-resolve-store`)];
    await run('pnpm', resolveLockfile, dir);

    if (assetDir) {
      const vendor = join(dir, assetDir, 'vendor', 'logbird');
      mkdirSync(vendor, { recursive: true });
      for (const file of [sdkFile, SUMS]) {
        const response = await fetch(`${releaseUrl}${file}`);
        check(response.ok, `downloaded ${file} from the Release URL (after its redirect)`);
        writeFileSync(join(vendor, file), Buffer.from(await response.arrayBuffer()));
      }
      const sums = parseSums(readFileSync(join(vendor, SUMS), 'utf8'));
      const digest = createHash('sha256')
        .update(readFileSync(join(vendor, sdkFile)))
        .digest('hex');
      check(digest === sums.get(sdkFile), `${sdkFile} matches ${SUMS}`);
    }
    if (name === 'filtered-url') {
      const before = requests;
      await run('pnpm', ['--filter', workspaceApp.name, 'add', url, '--store-dir', join(work, `${name}-add-store`)], dir);
      check(requests > before, 'filtered add downloaded the SDK tarball');
    } else {
      writeManifest(appDir, { ...workspaceApp, dependencies: { '@logbird/sdk': specifier } });
      await run('pnpm', resolveLockfile, dir);
    }
    const manifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
    check(manifest.dependencies['@logbird/sdk'] === specifier, 'the app manifest uses the requested SDK specifier');
    const lock = readFileSync(lockfile, 'utf8');
    const resolutions = [...lock.matchAll(/^ {4}resolution: \{([^}]+)\}$/gm)].map(([, value]) => value);
    const lockedTarball = assetDir ? `file:${assetDir === '.' ? '' : `${assetDir}/`}vendor/logbird/${sdkFile}` : url;
    check(
      resolutions.length === 1 && resolutions[0] === `integrity: ${expectedIntegrity}, tarball: ${lockedTarball}`,
      'the lockfile resolves only the SDK tarball, with its expected path and SHA-512 integrity',
    );
    const frozen = (suffix) => ['install', '--frozen-lockfile', '--store-dir', join(work, `${name}-${suffix}-store`)];
    removeWorkspaceModules(dir);
    const before = requests;
    await run('pnpm', frozen('frozen'), dir);
    check(
      assetDir ? requests === before : requests > before,
      assetDir ? 'frozen install used the local tarball' : 'frozen install fetched the release tarball again',
    );
    check(existsSync(join(appDir, 'node_modules', '@logbird', 'sdk', 'package.json')), 'the app has an installed SDK');
    check(readFileSync(lockfile, 'utf8') === lock, 'the frozen install left the lockfile unchanged');

    if (name === 'workspace-url') {
      // Whole-workspace resolution preserved integrity in this fixture. Inject its absence to check pnpm's refusal.
      writeFileSync(lockfile, lock.replace(`integrity: ${expectedIntegrity}, `, ''));
      removeWorkspaceModules(dir);
      const refused = await attempt('pnpm', frozen('missing-integrity'), dir);
      const error = `[ERR_PNPM_MISSING_TARBALL_INTEGRITY] Cannot install package "@logbird/sdk@${url}": its lockfile entry has no "integrity" field, so pnpm cannot verify the downloaded tarball.`;
      check(
        refused.status !== 0 && stripVTControlCharacters(refused.output).includes(error),
        'frozen install refused the URL after removing its integrity',
      );
    }

    if (assetDir) {
      // Copy the root metadata and what lives under the app, without the sibling or root-level vendor directory.
      const pruned = join(work, `${name}-pruned`);
      const prunedApp = join(pruned, workspaceAppPath);
      mkdirSync(prunedApp, { recursive: true });
      for (const file of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) copyFileSync(join(dir, file), join(pruned, file));
      copyFileSync(join(appDir, 'package.json'), join(prunedApp, 'package.json'));
      const refused = await attempt('pnpm', frozen('pruned-missing'), pruned);
      check(
        refused.status !== 0 && refused.output.includes('[ENOENT]') && refused.output.includes(sdkFile),
        'frozen install refused the manifest-only workspace without its tarball',
      );
      if (assetDir === workspaceAppPath) {
        removeWorkspaceModules(pruned);
        cpSync(join(appDir, 'vendor'), join(prunedApp, 'vendor'), { recursive: true });
        await run('pnpm', frozen('pruned'), pruned);
        check(
          existsSync(join(prunedApp, 'node_modules', '@logbird', 'sdk', 'package.json')),
          'copying the app vendor directory made the pruned install pass',
        );
        check(readFileSync(join(pruned, 'pnpm-lock.yaml'), 'utf8') === lock, 'the pruned install left the lockfile unchanged');
      }
    }
    passed.push(`pnpm ${workspaceVersion} workspace: ${name}`);
  }
  return [...passed, ...(await checkHoistedWorkspace(work, packageManager, url, expectedIntegrity))];
}

const work = mkdtempSync(join(tmpdir(), 'logbird-release-install-'));
const passed = [];
try {
  if (workspaceOnly) passed.push(...(await checkPnpmWorkspace(work)));
  for (const shapeName of workspaceOnly ? [] : shapes) {
    const shape = SHAPES[shapeName];
    for (const manager of managers) {
      for (const source of sources) {
        const label = `${shapeName === 'sdk' ? '@logbird/sdk alone' : '@logbird/sdk + @logbird/hono'}, ${manager}, ${
          source === 'file' ? 'downloaded tarballs (file:)' : 'Release URLs'
        }`;
        console.log(`\n== ${label}`);
        const dir = join(work, `${shapeName}-${manager}-${source}`);
        mkdirSync(join(dir, 'src'), { recursive: true });
        const caches = join(work, `${shapeName}-${manager}-${source}-caches`);
        let cacheRound = 0;
        const freshCache = () => join(caches, String(++cacheRound));
        const managerVersion = (await run(manager, ['--version'], dir, { capture: true })).trim();

        // 1. The specifier of each released package, and for file: the verified download.
        const files = Object.fromEntries(shape.released.map((name) => [name, tarballName(name, version)]));
        const spec = {};
        if (source === 'file') {
          const vendor = join(dir, 'vendor', 'logbird');
          // The documented download and verification, run as written (docs/integrating-a-backend.md, the SDK README)
          // wherever sh, curl and sha256sum exist: curl -fsSLO through the redirect, then one
          // `grep " <file>$" SHA256SUMS | sha256sum --check` per tarball, all chained with &&. Elsewhere (Windows without
          // those tools) Node downloads the files and the checks below verify them.
          const tools = spawnSync('sh', ['-c', 'command -v curl && command -v sha256sum'], { stdio: 'ignore' }).status === 0;
          const shell = (checker) => {
            const lines = [`version=${version}`, `base="${releaseUrl.slice(0, -1)}"`, 'mkdir -p vendor/logbird && cd vendor/logbird &&'];
            lines.push('  curl -fsSLO "$base/SHA256SUMS" &&');
            for (const name of shape.released) lines.push(`  curl -fsSLO "$base/${tarballName(name, '$version')}" &&`);
            for (const name of shape.released) lines.push(`  grep " ${tarballName(name, '$version')}\\$" SHA256SUMS | ${checker} &&`);
            lines.push('  cd ../..');
            return `${lines.join('\n')}\n`;
          };
          // Only the grep | check lines, against a given sums file, run inside vendor/logbird.
          const verifyOnly = (checker, sums) =>
            `version=${version}\n${shape.released.map((name) => `grep " ${tarballName(name, '$version')}\\$" ${sums} | ${checker}`).join(' &&\n')}\n`;
          const shasum = tools && spawnSync('sh', ['-c', 'command -v shasum'], { stdio: 'ignore' }).status === 0;
          if (tools) {
            writeFileSync(join(dir, 'download.sh'), shell('sha256sum --check'));
            await run('sh', ['download.sh'], dir);
            rmSync(join(dir, 'download.sh'));
            check(true, 'the documented curl and sha256sum chain downloaded and verified every tarball');
          } else {
            mkdirSync(vendor, { recursive: true });
            for (const file of [...Object.values(files), SUMS]) {
              const response = await fetch(`${releaseUrl}${file}`);
              check(response.ok, `downloaded ${file} from the Release URL (after its redirect)`);
              writeFileSync(join(vendor, file), Buffer.from(await response.arrayBuffer()));
            }
          }
          const sums = parseSums(readFileSync(join(vendor, SUMS), 'utf8'));
          for (const file of Object.values(files)) {
            const digest = createHash('sha256')
              .update(readFileSync(join(vendor, file)))
              .digest('hex');
            check(sums.get(file) === digest, `${file} matches ${SUMS}`);
          }
          // Each documented checker (sha256sum, and the macOS alternative `shasum -a 256` where it exists) passes, and
          // fails when SHA256SUMS lacks the line of one selected tarball (both refuse empty input), so no tarball is
          // ever left unchecked.
          if (tools) {
            const last = Object.values(files).at(-1);
            writeFileSync(
              join(vendor, 'SHA256SUMS.partial'),
              readFileSync(join(vendor, SUMS), 'utf8')
                .split('\n')
                .filter((line) => !line.endsWith(` ${last}`))
                .join('\n'),
            );
            for (const checker of ['sha256sum --check', ...(shasum ? ['shasum -a 256 --check'] : [])]) {
              writeFileSync(join(vendor, 'verify.sh'), verifyOnly(checker, SUMS));
              await run('sh', ['verify.sh'], vendor);
              writeFileSync(join(vendor, 'verify.sh'), verifyOnly(checker, 'SHA256SUMS.partial'));
              const partial = await attempt('sh', ['verify.sh'], vendor);
              check(partial.status !== 0, `\`${checker}\` passes, and fails when ${SUMS} has no line for ${last}`);
            }
            rmSync(join(vendor, 'SHA256SUMS.partial'));
            rmSync(join(vendor, 'verify.sh'));
          }
          for (const [name, file] of Object.entries(files)) spec[name] = `file:vendor/logbird/${file}`;
        } else {
          for (const [name, file] of Object.entries(files)) spec[name] = `${releaseUrl}${file}`;
        }

        // 2. The application and the documented install.
        const manifest = {
          name: 'logbird-release-install-check',
          version: '0.0.0',
          private: true,
          type: 'module',
          dependencies: shapeName === 'sdk' ? { ...shape.registry } : { ...spec, ...shape.registry },
          devDependencies: DEV,
        };
        const overrides = shapeName === 'sdk' ? { ...PINNED_OVERRIDES } : { '@logbird/sdk': spec['@logbird/sdk'], ...PINNED_OVERRIDES };
        if (manager === 'npm') manifest.overrides = overrides;
        writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        if (manager === 'pnpm') {
          const lines = Object.entries(overrides).map(([name, value]) => `  '${name}': ${value}`);
          writeFileSync(join(dir, 'pnpm-workspace.yaml'), `overrides:\n${lines.join('\n')}\n`);
        }
        // npm 12 refuses URL dependencies unless allowed; `root` allows the URLs named in this package.json only.
        if (manager === 'npm' && source === 'url') writeFileSync(join(dir, '.npmrc'), 'allow-remote=root\n');
        copyFileSync(shape.program, join(dir, 'src', 'main.ts'));
        copyFileSync(join(repo, 'tests', 'npm-consumer', 'tsconfig.json'), join(dir, 'tsconfig.json'));

        const install = async (frozen) =>
          manager === 'pnpm'
            ? // In CI pnpm defaults to --frozen-lockfile, so the first install says it may write the lockfile.
              await run('pnpm', ['install', frozen ? '--frozen-lockfile' : '--no-frozen-lockfile', '--store-dir', freshCache()], dir)
            : await run('npm', [frozen ? 'ci' : 'install', '--no-audit', '--no-fund', '--cache', freshCache()], dir);
        // pnpm 12 blocks a sub-dependency resolved from a URL (blockExoticSubdeps, on by default), which is what the
        // override makes of @logbird/hono's @logbird/sdk. The docs say so and send pnpm users to the downloaded tarballs,
        // which pnpm trusts; this proves the refusal is that rule and not something else.
        if (shapeName === 'hono' && manager === 'pnpm' && source === 'url' && Number(managerVersion.split('.')[0]) >= 12) {
          const refused = await attempt('pnpm', ['install', '--no-frozen-lockfile', '--store-dir', freshCache()], dir);
          check(
            refused.status !== 0 && /blockExoticSubdeps/.test(refused.output),
            `pnpm ${managerVersion} refuses Release URLs (blockExoticSubdeps)`,
          );
          passed.push(`${label}: pnpm ${managerVersion} refuses it (blockExoticSubdeps), as documented`);
          continue;
        }
        if (shapeName === 'sdk') {
          // The SDK README's command: `pnpm add ./vendor/logbird/<tarball>` (or the URL); npm: `npm install …`.
          const target = source === 'file' ? `./vendor/logbird/${files['@logbird/sdk']}` : spec['@logbird/sdk'];
          if (manager === 'pnpm') await run('pnpm', ['add', target, '--store-dir', freshCache()], dir);
          else await run('npm', ['install', target, '--no-audit', '--no-fund', '--cache', freshCache()], dir);
          const written = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies['@logbird/sdk'];
          check(written === spec['@logbird/sdk'], `the install wrote "@logbird/sdk": "${written.replace(releaseUrl, '<release>/')}" to package.json`);
        } else {
          await install(false);
        }

        // 3. The lockfile pins each released tarball by the integrity of the released file, one SDK, pinned registry.
        const lockfile = join(dir, manager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json');
        const lock = readFileSync(lockfile, 'utf8');
        for (const [name, file] of Object.entries(files)) {
          const expected = integrity(readFileSync(join(packages, file)));
          const pinned =
            manager === 'pnpm'
              ? [...lock.matchAll(/resolution: \{integrity: (sha512-[^,]+), tarball: ([^}]+)\}/g)]
                  .filter((m) => m[2].trim() === spec[name])
                  .map((m) => m[1])
              : [JSON.parse(lock).packages[`node_modules/${name}`]].filter((entry) => entry?.resolved === spec[name]).map((entry) => entry.integrity);
          check(
            pinned.length === 1 && pinned[0] === expected,
            `the lockfile pins ${name} to ${spec[name].replace(releaseUrl, '<release>/')} at ${expected.slice(0, 20)}…`,
          );
        }
        if (manager === 'pnpm') {
          const copies = readdirSync(join(dir, 'node_modules', '.pnpm')).filter((entry) => entry.startsWith('@logbird+sdk@'));
          check(copies.length === 1, `one @logbird/sdk in the store (${copies.join(', ')})`);
        } else {
          const copies = Object.keys(JSON.parse(lock).packages).filter((key) => key.endsWith('node_modules/@logbird/sdk'));
          check(copies.length === 1, `one @logbird/sdk in package-lock.json (${copies.join(', ')})`);
        }
        const expectedRegistry = { ...shape.registry, ...DEV, ...PINNED_OVERRIDES };
        const resolved = registryPackages(manager, lock);
        const sorted = (map) => JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b))));
        check(sorted(resolved) === sorted(expectedRegistry), `the registry packages are exactly the pinned ones: ${sorted(resolved)}`);
        if (shapeName === 'hono') {
          const resolvedFrom = (start) => {
            for (let at = realpathSync(start); ; at = dirname(at)) {
              const candidate = join(at, 'node_modules', '@logbird', 'sdk');
              if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
              if (dirname(at) === at) throw new Error(`no @logbird/sdk resolvable from ${start}`);
            }
          };
          check(
            resolvedFrom(join(dir, 'node_modules', '@logbird', 'hono')) === realpathSync(join(dir, 'node_modules', '@logbird', 'sdk')),
            '@logbird/hono resolves the same @logbird/sdk as the application',
          );
        }

        // 4. A clean, frozen reinstall from the lockfile.
        const before = requests;
        rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
        await install(true);
        if (source === 'url')
          check(requests - before === shape.released.length, 'the frozen install fetched the tarballs from the Release URL again');
        check(readFileSync(lockfile, 'utf8') === lock, 'the frozen install left the lockfile unchanged');

        // 5. TypeScript 6: type-check, compile and run.
        const tsc = join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
        const tscVersion = (await run(process.execPath, [tsc, '--version'], dir, { capture: true })).trim();
        check(/^Version 6\./.test(tscVersion), `TypeScript 6 compiles the consumer (${tscVersion})`);
        await run(process.execPath, [tsc, '-p', 'tsconfig.json'], dir);
        const output = await run(process.execPath, [join(dir, 'out', 'main.js')], dir, { capture: true });
        check(shape.passed.test(output), 'the compiled consumer ran and passed its checks');

        // 6. Other bytes in place of the released SDK: a valid tarball of the same package with one more (empty) tar
        // block, recompressed. A frozen install with an empty cache must refuse it on integrity alone.
        const sdkName = files['@logbird/sdk'];
        const altered = gzipSync(Buffer.concat([gunzipSync(readFileSync(join(packages, sdkName))), Buffer.alloc(512)]));
        if (source === 'file') writeFileSync(join(dir, 'vendor', 'logbird', sdkName), altered);
        else served.set(sdkName, altered);
        rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
        const tampered =
          manager === 'pnpm'
            ? // pnpm 12 has no --fetch-retries flag; earlier versions would otherwise retry for over a minute.
              await attempt(
                'pnpm',
                [
                  'install',
                  '--frozen-lockfile',
                  ...(Number(managerVersion.split('.')[0]) >= 12 ? [] : ['--fetch-retries=0']),
                  '--store-dir',
                  freshCache(),
                ],
                dir,
              )
            : await attempt('npm', ['ci', '--no-audit', '--no-fund', '--fetch-retries=0', '--cache', freshCache()], dir);
        served.set(sdkName, readFileSync(join(packages, sdkName)));
        check(
          tampered.status !== 0 && /integrity|EINTEGRITY|checksum/i.test(tampered.output),
          'a frozen install refuses an altered SDK tarball (integrity mismatch)',
        );

        passed.push(`${label}: ${manager} ${managerVersion}`);
      }
    }
  }
} finally {
  server.close();
  assets.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(`\nrelease install check passed for ${version}:\n${passed.map((line) => `- ${line}`).join('\n')}`);
