# Release install check

Proves the install recipes in [Install the SDK](../../docs/integrating-a-backend.md#install-the-sdk) and the
[SDK README](../../packages/sdk/README.md#install) work with the tarballs a release attaches. `run.mjs` serves the
release asset set from a local stand-in for `https://github.com/joodlab/logbird/releases/download/vX.Y.Z/` (which
redirects, as GitHub does) and writes a fresh application outside this repository, in two shapes:

- **`sdk`**: `@logbird/sdk` alone, installed with the README's command (`pnpm add <file or URL>`,
  `npm install <file or URL>`), no override; it runs `src/sdk-only.ts` (capture, a read, webhook verification);
- **`hono`**: `@logbird/sdk` and `@logbird/hono` in `package.json` with the documented override (pnpm:
  `pnpm-workspace.yaml`, npm: `package.json`); it runs `tests/npm-consumer/src/main.ts`;
- **`workspace`** (pnpm only, `workspace.mjs`): `@logbird/sdk` in one package of a small pnpm workspace; see below.

For each shape, package manager and source:

- **downloaded tarballs** (`file:`, the recommended recipe): downloads the tarballs and `SHA256SUMS` and verifies them
  (with the documented `grep " <file>$" SHA256SUMS | sha256sum --check` per tarball where `sha256sum` exists, which
  must also fail when `SHA256SUMS` lacks a tarball's line);
- **Release URLs**: depends on the URLs directly (npm gets `allow-remote=root` in `.npmrc`, which npm 12 requires);

then requires:

1. the lockfile to pin each released tarball with the SHA-512 integrity of the released file, a single
   `@logbird/sdk` (for `hono`, also the one `@logbird/hono` resolves), and every registry package at its pinned version;
2. a clean frozen reinstall (`pnpm install --frozen-lockfile`, `npm ci`, empty package cache) to succeed and leave the
   lockfile unchanged;
3. TypeScript 6 to type-check and compile the program (strict, `skipLibCheck: false`), and the result to run and pass
   its checks;
4. a frozen install to refuse an altered SDK tarball (a valid tarball with different bytes) on integrity.

With pnpm 11 and 12 the `hono` shape's URL form must fail with `ERR_PNPM_EXOTIC_SUBDEP` (`blockExoticSubdeps`), as the docs
state; the `sdk` shape's URL form works there.

## pnpm workspaces

The `workspace` shape backs [pnpm 11 workspaces](../../docs/integrating-a-backend.md#pnpm-11-workspaces). The fixture has
`apps/api` and `apps/web`, both depending on `packages/shared`; only `apps/api` depends on `@logbird/sdk`. It has no
registry packages. Every scenario uses stores and metadata caches of its own, and ends with a frozen install from an empty
store (or, where the lockfile pins nothing, asserts what that install does). The outcomes are asserted per pnpm major as
observed with 10.30.3, 11.8.0 and 12.6.0 (`OBSERVED` in `workspace.mjs`); another major fails the check until its
outcomes are recorded.

- `file:` with the tarball in `apps/api/vendor/logbird/` and with it at the workspace root: the lockfile pins it with the
  released integrity (also when the store already holds it), a frozen reinstall works, altered bytes are refused, and a
  pruned copy (root `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`, `apps/api`, `packages/shared`) installs
  `apps/api` frozen when the tarball is inside `apps/api`, and fails (`ENOENT` with pnpm 10 and 11,
  `ERR_PNPM_TARBALL_READ_LOCAL_TARBALL` with pnpm 12) when it is at the root.
- The Release URL, from an empty store: added by hand and resolved for the whole workspace
  (`pnpm install --lockfile-only`), or with `pnpm --filter @fixture/api add <URL>` (which leaves the other importers'
  lockfile entries unchanged here): the lockfile pins it, and a frozen install refuses altered bytes.
- The Release URL on a store that already holds its tarball (from an earlier install in another workspace):
  `pnpm install`, `pnpm install --fix-lockfile`, `pnpm --filter @fixture/api add <URL>`, and `pnpm install --lockfile-only`
  after an earlier `--lockfile-only`. pnpm 10 and 11 write `resolution: {tarball: <URL>}` with no integrity; pnpm 11's
  frozen install then stops with `ERR_PNPM_MISSING_TARBALL_INTEGRITY` (its scoped add stops with it already), and
  pnpm 10's frozen install succeeds and also installs altered bytes. pnpm 12 pins the integrity every time. A single
  project (`pnpm add <URL>`) on that store behaves the same way.
- The recipe the docs give for the URL: resolve with an empty `--store-dir` while the usual store holds the tarball. The
  lockfile pins it, a frozen install with the usual store works, and altered bytes are refused. Where pnpm drops the
  integrity (10 and 11), an entry already written without it stays without it under that command; `--fix-lockfile`
  from an empty store adds it with pnpm 10 and not with pnpm 11; removing the dependency, resolving, adding it back and
  resolving against an empty store pins it with both.

Nothing resolves an unpinned version, so the release workflow runs this check: the test application's registry
packages are exact (hono and `@types/node` as `tests/npm-consumer` pins them, TypeScript 6.0.3), and `@types/node`'s one
dependency, `undici-types`, is pinned by an override at the version `tests/npm-consumer/package-lock.json` locks. That
pin belongs to the test application, not to the documented recipe.

```sh
node scripts/npm-release-assets.mjs pack .tmp/npm                 # build, pack, check, SHA256SUMS
node tests/npm-release-install/run.mjs --packages=.tmp/npm         # pnpm and npm on PATH, every shape and source
node tests/npm-release-install/run.mjs --packages=.tmp/npm --shape=sdk --manager=npm --source=url
```

It uses the network for the application's registry packages, never for the Logbird packages. CI
(`.github/workflows/npm-tarballs.yml`) runs it with pnpm 10.30.3 and npm 10 on Node 22.18.0, with npm 12.1.0 on Node
24.22.3, with pnpm 11.8.0 on Node 22.18.0 (pinned by `pnpm11/package.json`), and with pnpm 12.6.0 on Node 24.22.3 (pinned by
`pnpm12/package.json`), on pull requests, master pushes and release tags. Every pnpm cell also runs the `workspace`
shape.
