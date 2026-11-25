# Release install check

Proves the install recipe in [Install the SDK](../../docs/integrating-a-backend.md#install-the-sdk) works with the
tarballs a release attaches. `run.mjs` serves the release asset set from a local stand-in for
`https://github.com/joodlab/logbird/releases/download/vX.Y.Z/` (which redirects, as GitHub does), writes a fresh
application outside this repository that installs `@logbird/sdk` and `@logbird/hono` with the documented override, and
for each package manager and source:

- **downloaded tarballs** (`file:`, the recommended recipe): downloads the two tarballs and `SHA256SUMS`, verifies
  them (with the documented `grep … SHA256SUMS | sha256sum --check` where `sha256sum` exists);
- **Release URLs**: depends on the URLs directly (npm gets `allow-remote=root` in `.npmrc`, which npm 12 requires);

then requires:

1. the lockfile to pin both tarballs with the SHA-512 integrity of the released files, and a single `@logbird/sdk`,
   which `@logbird/hono` also resolves;
2. a clean frozen reinstall (`pnpm install --frozen-lockfile`, `npm ci`, empty package cache) to succeed and leave the
   lockfile unchanged;
3. TypeScript 6 to type-check and compile `tests/npm-consumer/src/main.ts` (strict, `skipLibCheck: false`), and the
   result to run and pass its checks;
4. a frozen install to refuse an altered SDK tarball (a valid tarball with different bytes) on integrity.

pnpm 12 refuses the Release URL form (`ERR_PNPM_EXOTIC_SUBDEP`); with pnpm 12 the check requires exactly that refusal,
which the docs state.

```sh
node scripts/npm-release-assets.mjs pack .tmp/npm                 # build, pack, check, SHA256SUMS
node tests/npm-release-install/run.mjs --packages=.tmp/npm         # pnpm and npm on PATH, both sources
node tests/npm-release-install/run.mjs --packages=.tmp/npm --manager=npm --source=url
```

It uses the network for the application's registry dependencies (hono, TypeScript 6, `@types/node`), never for the
Logbird packages. CI (`.github/workflows/npm-tarballs.yml`) runs it with pnpm 10.30.3 and npm 10 on Node 22, and with
npm 12 on Node 24.
