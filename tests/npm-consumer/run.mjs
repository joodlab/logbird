#!/usr/bin/env node
// The npm consumer check (README.md). From the repository root:
//   node tests/npm-consumer/run.mjs [--project=phase1|adapters] [--skip-pack] [--hono=<version or range>] [--update-api]
// --skip-pack uses the tarballs already in the project's .packages folder (CI downloads them there).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const tests = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(tests, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const SDK = {
  name: '@logbird/sdk',
  dir: 'packages/sdk',
  reports: { sdk: 'index.d.mts', 'sdk-integration': 'integration.d.mts', 'sdk-read': 'read.d.mts' },
};
const HONO = { name: '@logbird/hono', dir: 'packages/integrations/hono', reports: { hono: 'index.d.mts' } };
const VUE = { name: '@logbird/vue', dir: 'packages/integrations/vue', reports: { vue: 'index.d.mts' } };
const NUXT = { name: '@logbird/nuxt', dir: 'packages/integrations/nuxt', reports: { nuxt: 'index.d.ts' } };
const TANSTACK = { name: '@logbird/tanstack-start', dir: 'packages/integrations/tanstack-start', reports: { 'tanstack-start': 'index.d.mts' } };
/**
 * phase1: @logbird/sdk and @logbird/hono, the packages applications install first, type-checked, run, and reported.
 * adapters: the integrations not published yet, type-checked and reported only. They need the SDK (and Nuxt, Vue)
 * installed from their tarballs too; its report belongs to phase1.
 */
const PROJECTS = {
  phase1: { dir: 'npm-consumer', install: [SDK, HONO], report: [SDK, HONO], tsconfigs: ['tsconfig.json', 'tsconfig.bundler.json'], run: true },
  adapters: {
    dir: 'npm-consumer-adapters',
    install: [SDK, VUE, NUXT, TANSTACK],
    report: [VUE, NUXT, TANSTACK],
    tsconfigs: ['tsconfig.json'],
    run: false,
  },
};
const project = PROJECTS[option('project') ?? 'phase1'];
if (!project) throw new Error(`unknown --project; use ${Object.keys(PROJECTS).join(' or ')}`);
const here = join(tests, project.dir);
const packed = join(here, '.packages');
const isWindows = process.platform === 'win32';

function run(command, commandArgs, cwd = here) {
  console.log(`$ ${command} ${commandArgs.join(' ')}`);
  // npm and pnpm are .cmd shims on Windows and need a shell; Node itself (whose path may hold spaces) does not.
  const shell = isWindows && command !== process.execPath;
  // Through cmd, an argument with a space or a metacharacter (a checkout under "C:\Work Projects\…" or
  // "C:\Work&Projects\…") must be quoted to stay one argument and not be read as an operator. Inside quotes cmd takes
  // & | < > ^ ( ) literally. A % is refused outright: cmd expands %VAR% even inside quotes, and no quoting prevents it.
  const quote = (arg) => {
    if (arg.includes('%')) throw new Error(`cannot pass an argument containing % through cmd safely: ${arg}`);
    return /[\s"&|<>^()]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;
  };
  const args = shell ? commandArgs.map(quote) : commandArgs;
  execFileSync(command, args, { cwd, stdio: 'inherit', shell });
}

/** One file's text from a .tgz (gzip, then tar headers), without a tar binary. */
function packedFile(file, path) {
  const tar = gunzipSync(readFileSync(file));
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    if (name === path) return tar.subarray(offset + 512, offset + 512 + size).toString('utf8');
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${file} has no ${path}`);
}

const tarball = (name) => {
  const prefix = `${name.replace('@', '').replace('/', '-')}-`;
  const found = readdirSync(packed).filter((file) => file.startsWith(prefix) && file.endsWith('.tgz') && /^\d/.test(file.slice(prefix.length)));
  if (found.length !== 1) throw new Error(`expected one ${prefix}<version>.tgz in ${packed}, found ${found.join(', ') || 'none'}`);
  return join(packed, found[0]);
};

// 1. Pack, as the release does: build, then pnpm pack (which applies publishConfig and replaces workspace:).
if (!flag('skip-pack')) {
  rmSync(packed, { recursive: true, force: true });
  mkdirSync(packed, { recursive: true });
  for (const { dir } of project.install) {
    run('pnpm', ['build'], join(repo, dir));
    run('pnpm', ['pack', '--pack-destination', packed], join(repo, dir));
  }
}

// 2. Install from the committed lockfile, then the tarballs over it without saving (their integrity changes per build).
run('npm', ['ci', '--no-audit', '--no-fund']);
const files = project.install.map(({ name }) => `./${relative(here, tarball(name)).replaceAll('\\', '/')}`);
// --hono=floor and --hono=latest test both ends of the peer range @logbird/hono declares, read from its tarball.
let hono = option('hono');
if (hono === 'floor' || hono === 'latest') {
  const range = JSON.parse(packedFile(tarball(HONO.name), 'package/package.json')).peerDependencies.hono;
  const floor = /^\^(\d+\.\d+\.\d+)$/.exec(range)?.[1];
  if (!floor) throw new Error(`@logbird/hono's hono peer range ${range} is not ^x.y.z; update run.mjs to test its ends`);
  if (hono === 'floor') hono = floor;
  else {
    // The newest stable release the caret range admits: same major, at or above the floor. Asked of the registry
    // directly (a shell on Windows would eat the "^").
    const parse = (version) => version.split('.').map(Number);
    const [major] = parse(floor);
    const atLeast = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2]);
    const versions = Object.keys((await (await fetch('https://registry.npmjs.org/hono')).json()).versions)
      .filter((version) => /^\d+\.\d+\.\d+$/.test(version) && parse(version)[0] === major && atLeast(parse(version), parse(floor)))
      .sort((a, b) => (atLeast(parse(a), parse(b)) ? (a === b ? 0 : 1) : -1));
    hono = versions.at(-1);
  }
  console.log(`hono peer range ${range}: testing ${hono}`);
}
run('npm', ['install', '--no-save', '--no-audit', '--no-fund', ...files, ...(hono ? [`hono@${hono}`] : [])]);
const installed = (name) => JSON.parse(readFileSync(join(here, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version;
// npm keeps the locked hono when the requested one conflicts with the peer range: never test a version other than
// the one asked for.
if (hono && /^\d+\.\d+\.\d+$/.test(hono) && installed('hono') !== hono) {
  throw new Error(`asked for hono ${hono}, but npm installed ${installed('hono')}`);
}
console.log(
  `installed: ${project.install.map(({ name }) => `${name}@${installed(name)}`).join(', ')}${project.run ? `, hono@${installed('hono')}` : ''}`,
);

// 3. Type-check under TypeScript 7 and 6.
const compiler = (dir) => {
  const manifest = JSON.parse(readFileSync(join(here, 'node_modules', dir, 'package.json'), 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin)[0];
  return join(here, 'node_modules', dir, bin);
};
const tsc7 = compiler('typescript');
const tsc6 = compiler('typescript6');
for (const [label, tsc] of [
  ['TypeScript 7', tsc7],
  ['TypeScript 6', tsc6],
]) {
  for (const tsconfig of project.tsconfigs) {
    console.log(`-- ${label}, ${tsconfig}`);
    run(process.execPath, [tsc, '-p', tsconfig, '--noEmit']);
  }
}

// 4. Build with TypeScript 7 and run on this Node.
if (project.run) {
  rmSync(join(here, 'out'), { recursive: true, force: true });
  run(process.execPath, [tsc7, '-p', 'tsconfig.json']);
  run(process.execPath, [join(here, 'out', 'main.js')]);
}

// 5. Public API reports, from the installed declarations: compared with api/, or written there with --update-api.
const temp = join(here, '.api-temp');
rmSync(temp, { recursive: true, force: true });
mkdirSync(temp, { recursive: true });
const apiDir = join(here, 'api');
mkdirSync(apiDir, { recursive: true });
const extractor = join(here, 'node_modules', '@microsoft', 'api-extractor', 'bin', 'api-extractor');
const slash = (path) => path.replaceAll('\\', '/');
const stale = [];
for (const { name, reports } of project.report) {
  // API Extractor treats every file under node_modules as an external package and looks for the analysed package's
  // package.json next to its config file. So the installed package is copied out of node_modules first (staying under
  // this folder, so its own imports still resolve), and the config is written into that copy. Otherwise a shared
  // declaration chunk (dist/index-<hash>.d.mts) would be reported as an opaque import and its members never compared.
  const folder = join(temp, name.replace('/', '__'));
  cpSync(join(here, 'node_modules', ...name.split('/')), folder, { recursive: true });
  for (const [reportName, entry] of Object.entries(reports)) {
    const report = `${reportName}.api.md`;
    const config = {
      projectFolder: slash(folder),
      mainEntryPointFilePath: `<projectFolder>/dist/${entry}`,
      compiler: {
        overrideTsconfig: {
          compilerOptions: {
            // bundler resolution follows extensionless relative imports in declarations (Nuxt's ./runtime/hooks),
            // which nodenext would leave unresolved and the report would list as opaque imports.
            module: 'esnext',
            moduleResolution: 'bundler',
            target: 'es2022',
            lib: ['es2022', 'dom'],
            strict: true,
            skipLibCheck: true,
            types: [],
          },
        },
      },
      apiReport: { enabled: true, reportFolder: slash(temp), reportTempFolder: slash(temp), reportFileName: report },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      messages: {
        compilerMessageReporting: { default: { logLevel: 'warning' } },
        // No release tags (@public, @beta) are used: every export is the public surface.
        extractorMessageReporting: { default: { logLevel: 'warning' }, 'ae-missing-release-tag': { logLevel: 'none', addToApiReportFile: false } },
        tsdocMessageReporting: { default: { logLevel: 'none' } },
      },
    };
    const configPath = join(folder, `api-extractor.${reportName}.json`);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    run(process.execPath, [extractor, 'run', '--local', '--config', configPath]);
    const generated = readFileSync(join(temp, report), 'utf8').replace(/\r\n/g, '\n');
    const committed = join(apiDir, report);
    if (flag('update-api')) {
      writeFileSync(committed, generated);
      console.log(`wrote ${project.dir}/api/${report}`);
    } else if (!existsSync(committed) || readFileSync(committed, 'utf8').replace(/\r\n/g, '\n') !== generated) {
      stale.push(report);
    }
  }
}
// A type a report only names ("needs to be exported by the entry point") must be defined in one of this project's
// reports, or a change to it would never show in a diff: export it, or stop naming a private alias.
const reportTexts = [];
for (const { reports } of project.report)
  for (const reportName of Object.keys(reports)) reportTexts.push(readFileSync(join(temp, `${reportName}.api.md`), 'utf8'));
const named = new Set(reportTexts.flatMap((text) => [...text.matchAll(/The symbol "([^"]+)" needs to be exported/g)].map((match) => match[1])));
const undefinedTypes = [...named].filter(
  (symbol) =>
    !reportTexts.some((text) => new RegExp(String.raw`^(export )?(declare )?(interface|type|class|function|const|enum) ${symbol}\b`, 'm').test(text)),
);
if (undefinedTypes.length) {
  console.error(`The public API names types that no report defines: ${undefinedTypes.join(', ')}. Export them from an entry point.`);
  process.exit(1);
}
if (stale.length) {
  console.error(`The public API changed: ${stale.join(', ')} differ from tests/${project.dir}/api/.`);
  console.error(
    `Review the change, then run \`node tests/npm-consumer/run.mjs --project=${option('project') ?? 'phase1'} --update-api\` and commit the reports.`,
  );
  process.exit(1);
}
console.log(`npm consumer check (${option('project') ?? 'phase1'}) passed`);
