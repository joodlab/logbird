# npm consumer check

Two applications outside the pnpm workspace (npm, each with its own `package-lock.json`) install the **packed**
tarballs, never the workspace sources, and check them the way a user would.

- **`tests/npm-consumer`** covers `@logbird/sdk` and `@logbird/hono`, the packages published first:
  - type-checks with `strict`, `exactOptionalPropertyTypes` and `skipLibCheck: false` (so the published declarations are
    checked too), under TypeScript 6.0 and 7.0, with `nodenext` and `bundler` resolution;
  - runs `src/main.ts` on Node against an in-process stand-in for the Logbird server: capture through the client and the
    Hono middleware, `createAudit`, a read with `trailQuery`, webhook signing and verification, client-level redaction,
    and redaction's identity rule.
- **`tests/npm-consumer-adapters`** covers `@logbird/vue`, `@logbird/nuxt` and `@logbird/tanstack-start`, not
  published yet. It type-checks `src/adapters.ts` under TypeScript 6.0 and 7.0 (`skipLibCheck: true`, since the
  frameworks' own declarations are not ours to fix), at the framework versions tested today.
- Both regenerate the public API reports in their `api/` folder with API Extractor, from the installed declarations, and
  fail when they differ from the committed ones. A changed report in a PR diff is a change to the public surface.

Run it from the repository root:

```sh
node tests/npm-consumer/run.mjs                      # pack, install, type-check, run, compare the API reports
node tests/npm-consumer/run.mjs --update-api         # the same, then write the new reports into api/
node tests/npm-consumer/run.mjs --hono=floor         # the lowest hono @logbird/hono's peer range admits
node tests/npm-consumer/run.mjs --hono=latest        # the newest hono it admits (or --hono=<version>)
node tests/npm-consumer/run.mjs --project=adapters   # the Vue, Nuxt and TanStack Start type check and reports
```

CI (`.github/workflows/npm-tarballs.yml`, called by `npm-packages.yml` on pull requests and by `release.yml` on a tag)
packs the five packages once with `scripts/npm-release-assets.mjs`, which checks the tarballs with
`scripts/check-npm-packages.mjs`, then runs the first project on Node 20 and 22 with the floor and the latest hono, the
adapters project once, and the [release install check](../npm-release-install/README.md). A release attaches exactly
those tarballs. If a floor stops passing, raise the floor in the package's `peerDependencies`; do not skip
the test.
