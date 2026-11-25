#!/usr/bin/env node
// The release install check (README.md): installs @logbird/sdk and @logbird/hono the way docs/integrating-a-backend.md
// tells a user to install a release, from a local stand-in for the GitHub Release download URL, into a fresh project
// outside this repository. From the repository root:
//
//   node tests/npm-release-install/run.mjs --packages=<folder> [--manager=pnpm|npm] [--source=file|url]
//
// <folder> holds the release asset set (scripts/npm-release-assets.mjs pack writes it). Without --manager and --source
// it runs every combination. Each one:
// 1. "downloads" the assets over HTTP from the stand-in (which redirects, as GitHub does) and, for --source=file,
//    verifies them against SHA256SUMS the way the docs do (`grep … SHA256SUMS | sha256sum --check` where it exists);
// 2. writes a consumer with both packages as dependencies and the override that points the integration's own
//    @logbird/sdk dependency at the same tarball (pnpm: pnpm-workspace.yaml; npm: package.json), then installs;
// 3. requires the lockfile to pin both tarballs with the sha512 integrity of the released files and to hold a single
//    @logbird/sdk, which is also the copy @logbird/hono resolves at run time;
// 4. deletes node_modules and the package cache and installs again with a frozen lockfile (`pnpm install
//    --frozen-lockfile`, `npm ci`), fetching the tarballs again;
// 5. type-checks tests/npm-consumer/src/main.ts under TypeScript 6 (strict, skipLibCheck false), compiles and runs it;
// 6. replaces the released SDK tarball with other bytes and requires a frozen install with an empty cache to refuse it.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** The consumer installs these two; the versions of its registry dependencies follow tests/npm-consumer. */
const RELEASED = ['@logbird/sdk', '@logbird/hono'];
const consumerManifest = JSON.parse(readFileSync(join(repo, 'tests', 'npm-consumer', 'package.json'), 'utf8'));
const REGISTRY = {
  dependencies: { hono: consumerManifest.devDependencies.hono },
  // TypeScript 6 under its own name, as a TypeScript 6 application has it.
  devDependencies: { typescript: '6.0.3', '@types/node': consumerManifest.devDependencies['@types/node'] },
};

const managers = option('manager') ? [option('manager')] : ['pnpm', 'npm'];
const sources = option('source') ? [option('source')] : ['file', 'url'];
for (const value of managers) if (!['pnpm', 'npm'].includes(value)) throw new Error(`unknown --manager=${value}`);
for (const value of sources) if (!['file', 'url'].includes(value)) throw new Error(`unknown --source=${value}`);

// Through cmd (pnpm and npm are .cmd shims on Windows), an argument with a space or metacharacter must be quoted.
const quote = (arg) => (/[\s"&|<>^()]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg);
// Asynchronous, so the stand-in server below (in this process) keeps answering while a package manager runs.
function exec(command, commandArgs, cwd, capture) {
  const shell = isWindows && command !== process.execPath;
  const child = spawn(command, shell ? commandArgs.map(quote) : commandArgs, {
    cwd,
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
async function run(command, commandArgs, cwd, { capture = false } = {}) {
  console.log(`$ ${command} ${commandArgs.join(' ')}`);
  const { status, output } = await exec(command, commandArgs, cwd, capture);
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

// The stand-in for https://github.com/joodlab/logbird/releases/download/v<version>/<asset>: it answers with a redirect
// to the file, as GitHub does, and can serve other bytes in place of an asset (step 6).
const served = new Map(readdirSync(packages).map((file) => [file, readFileSync(join(packages, file))]));
const downloadPath = `/joodlab/logbird/releases/download/v${version}/`;
let requests = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://stand-in');
  if (url.pathname.startsWith(downloadPath) && served.has(url.pathname.slice(downloadPath.length))) {
    response.statusCode = 302;
    response.setHeader('location', `/release-assets/${url.pathname.slice(downloadPath.length)}`);
    response.end();
    return;
  }
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
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const releaseUrl = `http://127.0.0.1:${server.address().port}${downloadPath}`;

const work = mkdtempSync(join(tmpdir(), 'logbird-release-install-'));
const passed = [];
try {
  for (const manager of managers) {
    for (const source of sources) {
      const label = `${manager}, ${source === 'file' ? 'downloaded tarballs (file:)' : 'Release URLs'}`;
      console.log(`\n== ${label}`);
      const dir = join(work, `${manager}-${source}`);
      mkdirSync(join(dir, 'src'), { recursive: true });
      const caches = join(work, `${manager}-${source}-caches`);
      let cacheRound = 0;
      const freshCache = () => join(caches, String(++cacheRound));

      // 1. The specifier of each released package, and for file: the verified download.
      const files = Object.fromEntries(RELEASED.map((name) => [name, tarballName(name, version)]));
      const spec = {};
      if (source === 'file') {
        const vendor = join(dir, 'vendor', 'logbird');
        mkdirSync(vendor, { recursive: true });
        for (const file of [...Object.values(files), SUMS]) {
          const response = await fetch(`${releaseUrl}${file}`);
          check(response.ok, `downloaded ${file} from the Release URL (after its redirect)`);
          writeFileSync(join(vendor, file), Buffer.from(await response.arrayBuffer()));
        }
        const sums = parseSums(readFileSync(join(vendor, SUMS), 'utf8'));
        for (const file of Object.values(files)) {
          const digest = createHash('sha256')
            .update(readFileSync(join(vendor, file)))
            .digest('hex');
          check(sums.get(file) === digest, `${file} matches ${SUMS}`);
        }
        // The documented command where sha256sum exists: only the selected tarballs' lines, and none may be missing.
        if (!isWindows && spawnSync('sha256sum', ['--version']).status === 0) {
          const pattern = ` logbird-(sdk|hono)-${version.replaceAll('.', '\\.')}\\.tgz$`;
          await run('sh', ['-c', `grep -E '${pattern}' ${SUMS} | sha256sum --check`], vendor);
        }
        for (const [name, file] of Object.entries(files)) spec[name] = `file:vendor/logbird/${file}`;
      } else {
        for (const [name, file] of Object.entries(files)) spec[name] = `${releaseUrl}${file}`;
      }

      // 2. The consumer, exactly as the docs write it.
      const manifest = {
        name: 'logbird-release-install-check',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: { ...spec, ...REGISTRY.dependencies },
        devDependencies: REGISTRY.devDependencies,
      };
      if (manager === 'npm') manifest.overrides = { '@logbird/sdk': spec['@logbird/sdk'] };
      writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      if (manager === 'pnpm') writeFileSync(join(dir, 'pnpm-workspace.yaml'), `overrides:\n  '@logbird/sdk': ${spec['@logbird/sdk']}\n`);
      // npm 12 refuses URL dependencies unless allowed; `root` allows the URLs named in this package.json only.
      if (manager === 'npm' && source === 'url') writeFileSync(join(dir, '.npmrc'), 'allow-remote=root\n');
      copyFileSync(join(repo, 'tests', 'npm-consumer', 'src', 'main.ts'), join(dir, 'src', 'main.ts'));
      copyFileSync(join(repo, 'tests', 'npm-consumer', 'tsconfig.json'), join(dir, 'tsconfig.json'));
      const managerVersion = (await run(manager, ['--version'], dir, { capture: true })).trim();

      const install = async (frozen) =>
        manager === 'pnpm'
          ? // In CI pnpm defaults to --frozen-lockfile, so the first install says it may write the lockfile.
            await run('pnpm', ['install', frozen ? '--frozen-lockfile' : '--no-frozen-lockfile', '--store-dir', freshCache()], dir)
          : await run('npm', [frozen ? 'ci' : 'install', '--no-audit', '--no-fund', '--cache', freshCache()], dir);
      // pnpm 12 blocks a sub-dependency resolved from a URL (blockExoticSubdeps, on by default), which is what the
      // override makes of @logbird/hono's @logbird/sdk. The docs say so and send pnpm users to the downloaded tarballs,
      // which pnpm trusts; this proves the refusal is that rule and not something else.
      if (manager === 'pnpm' && source === 'url' && Number(managerVersion.split('.')[0]) >= 12) {
        const refused = await attempt('pnpm', ['install', '--no-frozen-lockfile', '--store-dir', freshCache()], dir);
        check(refused.status !== 0 && /blockExoticSubdeps/.test(refused.output), `pnpm ${managerVersion} refuses Release URLs (blockExoticSubdeps)`);
        passed.push(`${label}: pnpm ${managerVersion} refuses it (blockExoticSubdeps), as documented`);
        continue;
      }
      await install(false);

      // 3. The lockfile pins each released tarball by the integrity of the released file, and there is one SDK.
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

      // 4. A clean, frozen reinstall from the lockfile.
      const before = requests;
      rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
      await install(true);
      if (source === 'url') check(requests - before === RELEASED.length, 'the frozen install fetched both tarballs from the Release URL again');
      check(readFileSync(lockfile, 'utf8') === lock, 'the frozen install left the lockfile unchanged');

      // 5. TypeScript 6: type-check, compile and run.
      const tsc = join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
      const tscVersion = (await run(process.execPath, [tsc, '--version'], dir, { capture: true })).trim();
      check(/^Version 6\./.test(tscVersion), `TypeScript 6 compiles the consumer (${tscVersion})`);
      await run(process.execPath, [tsc, '-p', 'tsconfig.json'], dir);
      const output = await run(process.execPath, [join(dir, 'out', 'main.js')], dir, { capture: true });
      check(/npm consumer: all \d+ checks passed/.test(output), 'the compiled consumer ran and passed its checks');

      // 6. Other bytes in place of the released SDK: a valid tarball of the same package with one more (empty) tar block,
      // recompressed. A frozen install with an empty cache must refuse it on integrity alone.
      const sdkName = files['@logbird/sdk'];
      const altered = gzipSync(Buffer.concat([gunzipSync(readFileSync(join(packages, sdkName))), Buffer.alloc(512)]));
      if (source === 'file') writeFileSync(join(dir, 'vendor', 'logbird', sdkName), altered);
      else served.set(sdkName, altered);
      rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
      const tampered =
        manager === 'pnpm'
          ? await attempt('pnpm', ['install', '--frozen-lockfile', '--fetch-retries=0', '--store-dir', freshCache()], dir)
          : await attempt('npm', ['ci', '--no-audit', '--no-fund', '--fetch-retries=0', '--cache', freshCache()], dir);
      served.set(sdkName, readFileSync(join(packages, sdkName)));
      check(
        tampered.status !== 0 && /integrity|EINTEGRITY|checksum/i.test(tampered.output),
        'a frozen install refuses an altered SDK tarball (integrity mismatch)',
      );

      passed.push(`${label}: ${manager} ${managerVersion}`);
    }
  }
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(`\nrelease install check passed for ${version}:\n${passed.map((line) => `- ${line}`).join('\n')}`);
