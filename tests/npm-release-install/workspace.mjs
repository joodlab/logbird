// The `workspace` shape of the release install check (README.md, "pnpm workspaces"): @logbird/sdk in one package of a
// small pnpm workspace (apps/api and apps/web, both depending on packages/shared; only apps/api depends on the SDK), in
// every form the docs discuss for a workspace, each followed by a frozen reinstall from an empty store:
//
// - file: with the tarball inside apps/api, and with it at the workspace root, including a "pruned" copy (the root
//   manifest, lockfile and pnpm-workspace.yaml plus the app's own packages, nothing else) installed for that app alone;
// - the Release URL resolved for the whole workspace and with `pnpm --filter <app> add <URL>`, from an empty store and
//   from a store that already holds that URL's tarball, and the empty-store resolution the docs recommend;
// - the same URL in a single project on a store that already holds it.
//
// The outcomes differ by pnpm major and are asserted as observed (pnpm 10.30.3, 11.8.0, 12.6.0), failures included, with
// their error codes, so a pnpm release that changes them fails this check. The workspace has no registry packages, so
// nothing here resolves anything from the registry.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// What each pnpm major did when this check was written. `storedUrl`: when the store already holds the tarball of a URL
// dependency, does resolving it again write its integrity to the lockfile? `frozenWithout`: what a frozen install does
// with a URL entry that has no integrity. `addWithStored`: what `pnpm --filter <app> add <URL>` does on such a store.
// `prunedRoot`: the error of a frozen install in a copy that lacks the workspace root's file: tarball.
const OBSERVED = {
  10: { storedUrl: 'drops integrity', frozenWithout: 'installs unverified', addWithStored: 'drops integrity', prunedRoot: 'ENOENT' },
  11: {
    storedUrl: 'drops integrity',
    frozenWithout: 'ERR_PNPM_MISSING_TARBALL_INTEGRITY',
    addWithStored: 'ERR_PNPM_MISSING_TARBALL_INTEGRITY',
    prunedRoot: 'ENOENT',
  },
  12: { storedUrl: 'keeps integrity', frozenWithout: null, addWithStored: 'keeps integrity', prunedRoot: 'ERR_PNPM_TARBALL_READ_LOCAL_TARBALL' },
};
const MISSING_INTEGRITY_TEXT = 'its lockfile entry has no "integrity" field, so pnpm cannot verify the downloaded tarball';

/**
 * @param {object} ctx
 * @param {string} ctx.dir an empty working folder
 * @param {string} ctx.source 'file' or 'url'
 * @param {string} ctx.managerVersion `pnpm --version`
 * @param {string} ctx.sdkFile the released SDK tarball's file name
 * @param {Buffer} ctx.sdkBytes the released SDK tarball
 * @param {Buffer} ctx.altered a valid tarball of the same package with other bytes
 * @param {string} ctx.sdkUrl the SDK's Release URL (the stand-in)
 * @param {(bytes: Buffer) => void} ctx.serve what the stand-in serves for the SDK from now on
 * @param {() => number} ctx.requests how many asset requests the stand-in has answered
 * @param {(command: string, args: string[], cwd: string) => Promise<{status: number, output: string}>} ctx.outcome
 * @param {(condition: boolean, message: string) => void} ctx.check
 * @param {(bytes: Buffer) => string} ctx.integrity
 * @returns {Promise<string[]>} one line per scenario that passed
 */
export async function workspaceCheck(ctx) {
  const { dir, source, managerVersion, sdkFile, sdkBytes, altered, sdkUrl, serve, requests, outcome, check, integrity } = ctx;
  const major = Number(managerVersion.split('.')[0]);
  const observed = OBSERVED[major];
  if (!observed) throw new Error(`no recorded workspace outcomes for pnpm ${managerVersion}: run this shape and record them in OBSERVED`);
  const released = integrity(sdkBytes);
  const shown = (spec) => spec.replace(sdkUrl, '<release URL>');
  const lines = [];

  let storeCount = 0;
  const newStore = () => join(dir, 'stores', String(++storeCount));
  // pnpm 12 has no --cache-dir; pnpm 10 and 11 get a metadata cache of their own next to each store.
  const storeArgs = (store) => ['--store-dir', store, ...(major < 12 ? ['--cache-dir', `${store}-cache`] : [])];
  // pnpm 12 has no --fetch-retries; earlier versions would otherwise retry a refused tarball for over a minute.
  const noRetries = major < 12 ? ['--fetch-retries=0'] : [];
  const pnpm = (cwd, args, store) => outcome('pnpm', [...args, ...storeArgs(store)], cwd);
  const must = async (cwd, args, store, what) => {
    const result = await pnpm(cwd, args, store);
    check(result.status === 0, what);
    return result;
  };

  const manifest = (name, dependencies) => `${JSON.stringify({ name, version: '0.0.0', private: true, type: 'module', dependencies }, null, 2)}\n`;
  const api = (ws) => join(ws, 'apps', 'api');
  /** A workspace with a lockfile and no SDK yet, installed with `store` (like an existing workspace). */
  const workspace = async (name, store) => {
    const ws = join(dir, name);
    for (const sub of ['apps/api', 'apps/web', 'packages/shared']) mkdirSync(join(ws, sub), { recursive: true });
    writeFileSync(
      join(ws, 'package.json'),
      `${JSON.stringify({ name: 'logbird-release-install-workspace', version: '0.0.0', private: true }, null, 2)}\n`,
    );
    writeFileSync(join(ws, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
    writeFileSync(
      join(ws, 'packages', 'shared', 'package.json'),
      manifest('@fixture/shared', {}).replace('"dependencies": {}', '"exports": "./index.js"'),
    );
    writeFileSync(join(ws, 'packages', 'shared', 'index.js'), "export const shared = 'shared';\n");
    writeFileSync(join(ws, 'apps', 'web', 'package.json'), manifest('@fixture/web', { '@fixture/shared': 'workspace:*' }));
    writeFileSync(join(api(ws), 'package.json'), manifest('@fixture/api', { '@fixture/shared': 'workspace:*' }));
    writeFileSync(
      join(api(ws), 'check.mjs'),
      [
        "import { shared } from '@fixture/shared';",
        "import { generateWebhookSecret, Logbird, signWebhook, verifyWebhook } from '@logbird/sdk';",
        "for (const value of [Logbird, signWebhook, verifyWebhook, generateWebhookSecret]) if (typeof value !== 'function') throw new Error('missing export');",
        "if (shared !== 'shared') throw new Error('workspace package missing');",
        "console.log('workspace consumer: apps/api loads @logbird/sdk');",
        '',
      ].join('\n'),
    );
    await must(ws, ['install', '--no-frozen-lockfile'], store, `${name}: a workspace of three packages installs without the SDK`);
    return ws;
  };
  const depend = (ws, spec) => {
    const file = join(api(ws), 'package.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    parsed.dependencies['@logbird/sdk'] = spec;
    writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  };
  const lockOf = (ws) => readFileSync(join(ws, 'pnpm-lock.yaml'), 'utf8');
  /** The lockfile's one tarball resolution: { integrity, tarball }. */
  const resolution = (ws) => {
    const found = [...lockOf(ws).matchAll(/^ {4}resolution: \{([^}]*)\}$/gm)].map((m) => m[1]).filter((r) => r.includes('tarball: '));
    if (found.length !== 1) throw new Error(`expected one tarball resolution in ${ws}/pnpm-lock.yaml, found ${found.length}`);
    return { integrity: /integrity: (sha512-[^,]+)/.exec(found[0])?.[1] ?? null, tarball: /tarball: ([^,]+)$/.exec(found[0])[1].trim() };
  };
  const pinned = (ws, tarball, what) => {
    const got = resolution(ws);
    check(got.tarball === tarball && got.integrity === released, `${what}: the lockfile pins ${shown(tarball)} at ${released.slice(0, 20)}…`);
  };
  const unpinned = (ws, tarball, what) => {
    const got = resolution(ws);
    check(
      got.tarball === tarball && got.integrity === null,
      `${what}: the lockfile records resolution: {tarball: ${shown(tarball)}} with no integrity`,
    );
  };
  const clean = (ws) => {
    for (const sub of ['', 'apps/api', 'apps/web', 'packages/shared']) rmSync(join(ws, sub, 'node_modules'), { recursive: true, force: true });
  };
  const frozen = async (ws, store, args = []) => {
    clean(ws);
    return pnpm(ws, ['install', '--frozen-lockfile', ...noRetries, ...args], store ?? newStore());
  };
  const runs = async (ws, what) => {
    const result = await outcome(process.execPath, [join(api(ws), 'check.mjs')], api(ws));
    check(result.status === 0 && /workspace consumer: apps\/api loads @logbird\/sdk/.test(result.output), `${what}: apps/api imports @logbird/sdk`);
  };
  const reinstalls = async (ws, what, store) => {
    const before = lockOf(ws);
    const result = await frozen(ws, store);
    check(result.status === 0, `${what}: a frozen reinstall${store ? '' : ' from an empty store'} succeeds`);
    check(lockOf(ws) === before, `${what}: the frozen reinstall left the lockfile unchanged`);
    await runs(ws, what);
  };
  const refusesAltered = async (ws, what, alter) => {
    const restore = alter();
    const result = await frozen(ws);
    restore();
    check(
      result.status !== 0 && /ERR_PNPM_TARBALL_INTEGRITY/.test(result.output),
      `${what}: a frozen install refuses an altered SDK tarball (ERR_PNPM_TARBALL_INTEGRITY)`,
    );
  };
  const alterServed = () => {
    serve(altered);
    return () => serve(sdkBytes);
  };
  /** What a frozen install does with the integrity-less entry, as `observed.frozenWithout` says. */
  const frozenWithoutIntegrity = async (ws, what) => {
    if (observed.frozenWithout === 'installs unverified') {
      const result = await frozen(ws);
      check(result.status === 0, `${what}: pnpm ${managerVersion}'s frozen install accepts the entry without integrity`);
      const before = requests();
      const restore = alterServed();
      const unverified = await frozen(ws);
      restore();
      check(
        unverified.status === 0 && requests() > before,
        `${what}: and installs an altered SDK tarball from the URL without a complaint (nothing pins the bytes)`,
      );
      return;
    }
    const result = await frozen(ws);
    check(
      result.status !== 0 && result.output.includes(observed.frozenWithout) && result.output.includes(MISSING_INTEGRITY_TEXT),
      `${what}: the frozen install stops with ${observed.frozenWithout} ("${MISSING_INTEGRITY_TEXT}")`,
    );
  };

  if (source === 'file') {
    // The documented download is checked by the other shapes; here the released bytes are placed directly.
    for (const where of ['app', 'root']) {
      const what = where === 'app' ? 'file:, tarball inside apps/api' : 'file:, tarball at the workspace root';
      const spec = where === 'app' ? `file:vendor/logbird/${sdkFile}` : `file:../../vendor/logbird/${sdkFile}`;
      const recorded = where === 'app' ? `file:apps/api/vendor/logbird/${sdkFile}` : `file:vendor/logbird/${sdkFile}`;
      // One store for both installs below, so the second resolves the file with its tarball already in the store.
      const store = newStore();
      let ws;
      for (const round of ['', '-again']) {
        ws = await workspace(`file-${where}${round}`, store);
        const vendor = where === 'app' ? join(api(ws), 'vendor', 'logbird') : join(ws, 'vendor', 'logbird');
        mkdirSync(vendor, { recursive: true });
        writeFileSync(join(vendor, sdkFile), sdkBytes);
        depend(ws, spec);
        await must(ws, ['install', '--no-frozen-lockfile'], store, `${what}${round ? ', store already holding it' : ''}: pnpm install resolves it`);
        pinned(ws, recorded, `${what}${round ? ', store already holding it' : ''}`);
      }
      await reinstalls(ws, what);
      // A pruned build context: the root manifest, lockfile and pnpm-workspace.yaml, apps/api and what it depends on.
      const pruned = join(dir, `file-${where}-pruned`);
      for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) cpSync(join(ws, file), join(pruned, file));
      for (const sub of ['apps/api', 'packages/shared'])
        cpSync(join(ws, sub), join(pruned, sub), { recursive: true, filter: (from) => !from.includes('node_modules') });
      const prunedInstall = await pnpm(pruned, ['install', '--frozen-lockfile', ...noRetries, '--filter', '@fixture/api...'], newStore());
      if (where === 'app') {
        check(prunedInstall.status === 0, `${what}: a pruned copy (root manifests, apps/api, packages/shared) installs apps/api frozen`);
        const result = await outcome(process.execPath, [join(api(pruned), 'check.mjs')], api(pruned));
        check(result.status === 0, `${what}: apps/api imports @logbird/sdk in the pruned copy`);
      } else {
        check(
          // pnpm 12 wraps its message across lines, so whitespace is removed before looking for the path.
          prunedInstall.status !== 0 &&
            prunedInstall.output.includes(observed.prunedRoot) &&
            new RegExp(`vendor[\\\\/]logbird[\\\\/]${sdkFile.replaceAll('.', '\\.')}`).test(prunedInstall.output.replace(/\s+/g, '')),
          `${what}: the pruned copy fails (${observed.prunedRoot}, naming vendor/logbird/${sdkFile})`,
        );
      }
      const tarball = where === 'app' ? join(api(ws), 'vendor', 'logbird', sdkFile) : join(ws, 'vendor', 'logbird', sdkFile);
      await refusesAltered(ws, what, () => {
        writeFileSync(tarball, altered);
        return () => writeFileSync(tarball, sdkBytes);
      });
      lines.push(
        `workspace, ${what}: lockfile pins it with integrity; ${where === 'app' ? 'a pruned copy installs' : `a pruned copy fails (${observed.prunedRoot})`}`,
      );
    }
    return lines;
  }

  // 1. The URL added by hand, resolved for the whole workspace, from an empty store.
  {
    const what = 'URL, whole workspace, empty store';
    const store = newStore();
    const ws = await workspace('url-cold', store);
    depend(ws, sdkUrl);
    await must(ws, ['install', '--lockfile-only', '--no-frozen-lockfile'], store, `${what}: pnpm install --lockfile-only resolves it`);
    pinned(ws, sdkUrl, what);
    await reinstalls(ws, what);
    await refusesAltered(ws, what, alterServed);
    lines.push(`workspace, ${what}: lockfile pins it with integrity`);
  }
  // 2. A scoped add, from an empty store: only apps/api's importer changes in this workspace.
  {
    const what = 'URL, pnpm --filter @fixture/api add, empty store';
    const store = newStore();
    const ws = await workspace('url-add-cold', store);
    const before = importers(lockOf(ws));
    await must(ws, ['--filter', '@fixture/api', 'add', sdkUrl], store, `${what}: the scoped add succeeds`);
    const written = JSON.parse(readFileSync(join(api(ws), 'package.json'), 'utf8')).dependencies['@logbird/sdk'];
    check(written === sdkUrl, `${what}: it wrote "@logbird/sdk": "${shown(written)}" to apps/api/package.json`);
    pinned(ws, sdkUrl, what);
    const after = importers(lockOf(ws));
    const others = Object.keys(before).filter((key) => key !== 'apps/api');
    check(
      others.length === 3 && others.every((key) => after[key] === before[key]) && Object.keys(after).length === Object.keys(before).length,
      `${what}: no other importer's lockfile entry changed (${others.join(', ')})`,
    );
    await reinstalls(ws, what);
    lines.push(`workspace, ${what}: lockfile pins it with integrity, other importers unchanged`);
  }
  // 3. A store that already holds the URL's tarball, from an earlier full install of it in another workspace.
  const warm = newStore();
  {
    const ws = await workspace('url-warm-up', warm);
    depend(ws, sdkUrl);
    await must(ws, ['install', '--no-frozen-lockfile'], warm, 'store warm-up: a full install of the URL in another workspace');
    pinned(ws, sdkUrl, 'store warm-up (empty store until now)');
  }
  for (const [slug, name, args] of [
    ['install', 'pnpm install', ['install', '--no-frozen-lockfile']],
    ['fix-lockfile', 'pnpm install --fix-lockfile', ['install', '--fix-lockfile', '--no-frozen-lockfile']],
  ]) {
    const what = `URL, whole workspace (${name}), store already holding it`;
    const ws = await workspace(`url-warm-${slug}`, warm);
    depend(ws, sdkUrl);
    await must(ws, args, warm, `${what}: the install succeeds`);
    if (observed.storedUrl === 'keeps integrity') {
      pinned(ws, sdkUrl, what);
      await reinstalls(ws, what);
    } else {
      unpinned(ws, sdkUrl, what);
      await frozenWithoutIntegrity(ws, what);
    }
    lines.push(`workspace, ${what}: ${observed.storedUrl}${observed.frozenWithout ? `, then frozen: ${observed.frozenWithout}` : ''}`);
  }
  {
    const what = 'URL, pnpm --filter @fixture/api add, store already holding it';
    const ws = await workspace('url-add-warm', warm);
    const result = await pnpm(ws, ['--filter', '@fixture/api', 'add', sdkUrl], warm);
    if (observed.addWithStored.startsWith('ERR_')) {
      check(
        result.status !== 0 && result.output.includes(observed.addWithStored) && result.output.includes(MISSING_INTEGRITY_TEXT),
        `${what}: the add itself stops with ${observed.addWithStored}`,
      );
    } else {
      check(result.status === 0, `${what}: the add succeeds`);
      if (observed.addWithStored === 'keeps integrity') pinned(ws, sdkUrl, what);
      else unpinned(ws, sdkUrl, what);
    }
    lines.push(`workspace, ${what}: ${observed.addWithStored}`);
  }
  // 4. --lockfile-only on a store an earlier --lockfile-only resolution of the URL warmed.
  {
    const what = 'URL, whole workspace (pnpm install --lockfile-only), after an earlier --lockfile-only';
    const store = newStore();
    const up = await workspace('url-lockfile-only-warm-up', store);
    depend(up, sdkUrl);
    await must(up, ['install', '--lockfile-only', '--no-frozen-lockfile'], store, 'store warm-up: --lockfile-only in another workspace');
    pinned(up, sdkUrl, 'store warm-up by --lockfile-only (empty store until now)');
    const ws = await workspace('url-lockfile-only-warm', store);
    depend(ws, sdkUrl);
    await must(ws, ['install', '--lockfile-only', '--no-frozen-lockfile'], store, `${what}: the resolution succeeds`);
    if (observed.storedUrl === 'keeps integrity') {
      pinned(ws, sdkUrl, what);
      await reinstalls(ws, what);
    } else {
      unpinned(ws, sdkUrl, what);
      await frozenWithoutIntegrity(ws, what);
    }
    lines.push(`workspace, ${what}: ${observed.storedUrl}`);
  }
  // 5. The docs' URL recipe: resolve once against a new, empty store; later installs use the usual (warm) store.
  {
    const what = 'URL, whole workspace, resolved with an empty --store-dir while the usual store holds it';
    const ws = await workspace('url-empty-store-recipe', warm);
    depend(ws, sdkUrl);
    await must(
      ws,
      ['install', '--lockfile-only', '--no-frozen-lockfile'],
      newStore(),
      `${what}: pnpm install --lockfile-only --store-dir <empty folder>`,
    );
    pinned(ws, sdkUrl, what);
    await reinstalls(ws, `${what}, frozen install with the usual store`, warm);
    await refusesAltered(ws, what, alterServed);
    lines.push(`workspace, ${what}: lockfile pins it with integrity`);
  }
  // 6. Not a workspace effect: a single project on the same store.
  {
    const what = 'URL, single project (pnpm add), store already holding it';
    const project = join(dir, 'url-single-project');
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, 'package.json'),
      `${JSON.stringify({ name: 'logbird-release-install-single', version: '0.0.0', private: true }, null, 2)}\n`,
    );
    await must(project, ['add', sdkUrl], warm, `${what}: pnpm add succeeds`);
    if (observed.storedUrl === 'keeps integrity') pinned(project, sdkUrl, what);
    else unpinned(project, sdkUrl, what);
    lines.push(`${what}: ${observed.storedUrl}`);
  }
  if (!existsSync(join(dir, 'stores'))) throw new Error('no store was used');
  return lines;
}

/** The lockfile's importers section, as importer path → its text. */
function importers(lock) {
  const section = lock.split(/^importers:$/m)[1]?.split(/^\S/m)[0] ?? '';
  // Each importer starts at a two-space-indented key (`  apps/api:`, or `  .: {}` on one line) and runs to the next one.
  const blocks = section
    .split(/\n(?= {2}\S)/)
    .map((block) => block.trim())
    .filter(Boolean);
  return Object.fromEntries(blocks.map((block) => [block.slice(0, block.indexOf(':')), block]));
}
