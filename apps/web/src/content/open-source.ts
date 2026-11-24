import { ORG_NAME } from '../env';
import { latestRelease, NO_RELEASES, supportedLine } from '../lib/releases';
import { byRepo, SITE } from './site';

const repo: { path: string; what: string }[] = [
  { path: 'apps/server', what: 'The API: ingest and read on `/v1`, the console API on `/api`, OpenAPI and a Scalar reference. Hono on Node.' },
  { path: 'apps/app', what: 'The console. TanStack Start and React.' },
  { path: 'apps/worker', what: 'The retention worker: hourly purges and housekeeping. BullMQ on Redis or Dragonfly.' },
  { path: 'apps/email', what: 'Previews for the sign-in and invitation email templates.' },
  { path: 'packages/contracts', what: "The API's request and response schemas. The source of truth for the API." },
  { path: 'packages/clickhouse', what: 'ClickHouse client, migrations, query builder and query-language parser.' },
  { path: 'packages/database', what: 'Postgres schema (Prisma): workspaces, projects, keys, saved views.' },
  { path: 'packages/auth', what: 'Email one-time-code sign-in and workspaces, on better-auth.' },
  { path: 'packages/sdk', what: '`@logbird/sdk`: the TypeScript client. No dependencies.' },
  { path: 'packages/integrations/*', what: '`@logbird/hono`, `@logbird/tanstack-start`, `@logbird/vue`, `@logbird/nuxt`.' },
  { path: 'packages/ui', what: "The console's design system." },
  { path: 'packages/seed', what: 'A generator of fictional hotel-booking data, sent through the public API.' },
  { path: 'examples/*', what: 'Small runnable examples for each integration.' },
];

const contributing = [
  'Node 22.18+ and pnpm',
  'Focused branches and Conventional Commits',
  'Pull requests that explain what changed, why, and how it was verified',
  'Screenshots for UI changes',
  'Fictional data only in tests',
  'Maintainers merge',
];

/** Words of /open-source. Brief: marketing/copy/open-source.md. Inline marks: `code` (components/marketing/rich.tsx). */
export const openSource = {
  source: {
    public: 'Source on GitHub',
    private: 'Source on GitHub — coming soon',
  },
  license: {
    barTitle: 'LICENSE',
    name: 'MIT License',
    /** The copyright line names the publisher, which is pending the owner (WEB_ORG_NAME); quoted only once set. */
    copyright: ORG_NAME ? `Copyright (c) 2026 ${ORG_NAME}` : undefined,
    excerpt: 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software…',
    freedoms: ['Read it', 'Run it', 'Change it', 'Ship it in your product'],
  },
  hero: {
    eyebrow: 'Open source',
    title: 'The product is MIT-licensed.',
    lead: 'The product is MIT-licensed: the API, the console, the retention worker, the SDK and the integrations, all in one repository. You can read the code, run it, change it and ship it in your own product. Experimental folders may carry their own licence; each one says so.',
    /** Under the hero actions while the repository is private. */
    privateNote: byRepo(SITE, { public: undefined, private: "The repository opens publicly soon. Until then, the code isn't public." }),
  },
  repo: {
    eyebrow: "What's in the repository",
    title: 'One repository, one codebase.',
    caption: 'What each folder of the Logbird repository contains',
    column: 'What it is',
    header: 'Path',
    rows: repo,
  },
  contributing: {
    eyebrow: 'Contributing',
    title: 'How to contribute.',
    lead: `${byRepo(SITE, { public: 'Contributions', private: 'Once the repository is public, contributions' })} follow \`CONTRIBUTING.md\`. In short: Node 22.18+ and pnpm, focused branches, Conventional Commits, and pull requests that explain what changed, why, and how it was verified. UI changes include screenshots. Tests use fictional data only. Maintainers merge.`,
    checklist: contributing,
    notes: [
      'API changes start in `packages/contracts`. The server and console change in the same pull request.',
      'GitHub Actions runs the checks on every pull request and push to master. A `v*` tag builds the release images for amd64 and arm64 and publishes them to GHCR.',
    ],
  },
  conduct: {
    eyebrow: 'Code of conduct',
    title: 'Be kind and constructive.',
    body: 'The project follows the Contributor Covenant, version 2.1. Report conduct issues through the private channel described in `SECURITY.md`.',
  },
  security: {
    eyebrow: 'Security reports',
    title: 'Found a vulnerability? Tell us privately.',
    /** The security contact (components/marketing/security-contact.tsx) sits between these two. */
    before: "Don't open a public issue. ",
    after:
      " Include the affected version, a reproduction with fictional data, and the impact. We coordinate the fix and the disclosure with you privately. We don't offer a response-time SLA yet.",
    action: 'Security and data handling',
  },
  versions: {
    eyebrow: 'Versions',
    title: 'Where the project is today.',
    lead: `${latestRelease && supportedLine ? `The supported line is ${supportedLine}, and the latest release is ${latestRelease.version}, with Docker images on GHCR for amd64 and arm64.` : NO_RELEASES} The SDK and the integrations share the platform's version. \`@logbird/sdk\` and \`@logbird/hono\` are on npm; the Vue, Nuxt and TanStack Start integrations aren't yet${byRepo(SITE, { public: ': use them from source.', private: '.' })}`,
    action: 'Read the changelog',
    facts: [
      { label: 'Supported line', value: supportedLine ?? '—' },
      { label: 'Latest release', value: latestRelease ? latestRelease.version : '—' },
      { label: 'Docker images', value: latestRelease ? 'GHCR' : '—' },
      { label: 'npm packages', value: '@logbird/sdk, @logbird/hono' },
    ],
  },
} as const;
