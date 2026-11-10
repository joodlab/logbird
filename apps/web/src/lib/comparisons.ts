/**
 * Every fact on the /compare pages, with its sources. Copy: marketing/copy/compare/*.md — change the wording there
 * first, then here. Rules: official sources only, every claim about another product cites a source, anything we
 * couldn't verify stays out of the table (it's listed under `unverified`), no logos, no disparagement.
 *
 * Inline marks: `code` and **bold** (rendered by components/marketing/rich.tsx).
 */

import { GITHUB_PUBLIC } from '../env';
import { CLOUD_OPEN } from './cloud';

export const ACCESSED = '2026-11-07';

export const TRADEMARK_LINE =
  "All product names are trademarks of their respective owners. Logbird isn't affiliated with or endorsed by any of them.";

export interface ComparisonSource {
  /** Footnote id as written in the copy, e.g. `S5`. */
  id: string;
  title: string;
  url: string;
  /** Further official pages for the same claim. */
  also?: string[];
  accessed: string;
}

export interface ComparisonRow {
  label: string;
  logbird: string;
  them: string;
  /** Sources for the claim in `them`. Logbird's column describes this repository. */
  sourceIds: string[];
}

export interface Comparison {
  slug: 'retraced' | 'workos-audit-logs' | 'pangea' | 'bemi';
  path: string;
  /** Product name as its owner writes it; used for the table column and "When to choose …". */
  name: string;
  title: string;
  summary: string;
  summarySourceIds: string[];
  note?: { kind: 'status' | 'category'; title: string; body: string; sourceIds: string[] };
  /** One-line description for the /compare index card. */
  card: string;
  /** "Fits when …" line for the /compare index. */
  fit: string;
  rows: ComparisonRow[];
  chooseThem: string[];
  chooseLogbird: string[];
  sources: ComparisonSource[];
  unverified: string;
}

const src = (id: string, title: string, url: string, also?: string[]): ComparisonSource => ({
  id,
  title,
  url,
  ...(also ? { also } : {}),
  accessed: ACCESSED,
});

const range = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => `${prefix}${from + index}`);

// Nobody can self-host before the source opens, so the cell says so until WEB_GITHUB_PUBLIC=true.
const LOGBIRD_SELF_HOST = GITHUB_PUBLIC
  ? 'Yes: Docker Compose or Coolify, with published images'
  : 'Planned: Docker Compose or Coolify, when the source opens';
// Licence and hosting cells follow the same availability state.
const LOGBIRD_SOURCE = GITHUB_PUBLIC ? 'MIT; source on GitHub' : 'MIT; source opens publicly soon';
const LOGBIRD_CLOUD = CLOUD_OPEN ? 'Logbird Cloud early access (invited teams)' : 'Logbird Cloud waitlist';
const LOGBIRD_HOSTING = GITHUB_PUBLIC ? `Self-hosted, MIT; ${LOGBIRD_CLOUD}` : `Self-hosted when the source opens (MIT); ${LOGBIRD_CLOUD}`;
const LOGBIRD_HOSTED_OFFERING = CLOUD_OPEN ? 'Logbird Cloud: early access for invited teams' : 'Logbird Cloud: waitlist only';
const LOGBIRD_PRICING = 'Self-host free (MIT); Cloud pricing not set';
const LOGBIRD_VIEWER = 'None yet; read API plus headless Vue helpers';
const LOGBIRD_READ = '`GET /v1/events` with a project read key';
const LOGBIRD_STORAGE = 'ClickHouse for events, Postgres for metadata';

const retraced: Comparison = {
  slug: 'retraced',
  path: '/compare/retraced',
  name: 'Retraced',
  title: 'Logbird and Retraced',
  summary:
    "Retraced is an open-source audit log service. Replicated created it, and BoxyHQ later co-maintained it. It has an API to send events, an embeddable viewer so your customers can browse their own events, and an Enterprise API so their IT teams can pull events out programmatically. It runs on Postgres with optional Elasticsearch, and you deploy it yourself. Its embeddable, customer-facing viewer is a real strength: Logbird doesn't have one today.",
  summarySourceIds: range('S', 1, 4),
  card: 'An open-source (Apache-2.0) audit log service with an embeddable React viewer. Self-hosted.',
  fit: 'You want to embed an audit log viewer in your own React app, in a self-hosted Apache-2.0 service.',
  rows: [
    { label: 'Licence', logbird: 'MIT', them: 'Apache-2.0', sourceIds: ['S5'] },
    {
      label: 'Self-host',
      logbird: LOGBIRD_SELF_HOST,
      them: 'Yes: Docker Compose; also documented for DigitalOcean, AWS and Skaffold; the Kubernetes docs page says "Coming soon"',
      sourceIds: ['S6', 'S7'],
    },
    { label: 'Hosted offering', logbird: LOGBIRD_HOSTED_OFFERING, them: 'None found', sourceIds: ['S8'] },
    {
      label: 'Required event fields',
      logbird: '`action` only; any other shape accepted',
      them: '`action` and `crud` in the API spec; the docs also list `actor` as mandatory',
      sourceIds: ['S9', 'S10'],
    },
    { label: 'Tenant field', logbird: '`tenant` (optional)', them: '`group` (optional in the API spec)', sourceIds: ['S10'] },
    {
      label: 'Search',
      logbird: 'Query language with ranges, regex and groups; guarded SQL `WHERE` mode in the console',
      them: 'GraphQL search; free text or `key:value` filters on `action`, `crud`, `received` and `actor`',
      sourceIds: ['S11', 'S12'],
    },
    {
      label: 'Retention',
      logbird: 'Per project, 7 days to 10 years; hourly permanent deletion with a preview',
      them: 'No retention setting in the documented configuration',
      sourceIds: ['S13'],
    },
    {
      label: 'Customer-facing viewer',
      logbird: LOGBIRD_VIEWER,
      them: 'Embeddable React viewer (`@retracedhq/logs-viewer`), with scoped viewer tokens',
      sourceIds: ['S14'],
    },
    { label: 'Programmatic read', logbird: LOGBIRD_READ, them: 'Enterprise API (GraphQL) for end customers', sourceIds: ['S15'] },
    { label: 'Storage', logbird: LOGBIRD_STORAGE, them: 'Postgres; optional Elasticsearch; NSQ queue', sourceIds: ['S4', 'S13'] },
    { label: 'Pricing', logbird: LOGBIRD_PRICING, them: 'No pricing page found', sourceIds: ['S8'] },
    {
      label: 'Latest release',
      logbird: 'Not released yet (0.1 line)',
      them: 'v1.13.1, 6 Nov 2024; latest commit on `main` 26 Aug 2025; not archived',
      sourceIds: ['S16', 'S17'],
    },
  ],
  chooseThem: [
    'You want to **embed an audit log viewer in your own React app**, so customers can browse their own events.',
    "Your customers' IT teams need a **programmatic API of their own** to pull their events.",
    'You prefer **Apache-2.0**, or you already run Postgres and Elasticsearch and want the audit log there too.',
    "You want a project with **a release history** behind it. Logbird hasn't made its first release yet.",
  ],
  chooseLogbird: [
    'You want to **send any event shape** and get a recommended envelope without a fixed schema.',
    'Your team needs an **operator console** that can follow actors, tenants, workers and records, and show operation trees with retries.',
    'You need **retention you can explain**: a window per project, a preview of what will be deleted, and permanent deletion.',
    'You want events stored in **ClickHouse**, with a SQL `WHERE` mode for hard questions.',
  ],
  sources: [
    src('S1', 'Repository description: "A fully open source audit logs service and embeddable UI…"', 'https://github.com/retracedhq/retraced'),
    src(
      'S2',
      'README: searchable, exportable record of events; Go and JavaScript clients',
      'https://raw.githubusercontent.com/retracedhq/retraced/main/README.md',
    ),
    src(
      'S3',
      'Basics: Publisher API, embedded Logs Viewer, Enterprise IT Integration API',
      'https://raw.githubusercontent.com/retracedhq/docs/main/getting-started/retraced-basics.md',
    ),
    src(
      'S4',
      'Docs overview: "Supports Postgres for now"; Elasticsearch optional',
      'https://raw.githubusercontent.com/retracedhq/docs/main/README.md',
    ),
    src('S5', 'Licence file: Apache License, Copyright 2019 Replicated, Inc.', 'https://raw.githubusercontent.com/retracedhq/retraced/main/LICENSE'),
    src(
      'S6',
      'Self-host options: Docker, DigitalOcean, AWS, Kubernetes, Skaffold',
      'https://raw.githubusercontent.com/retracedhq/docs/main/self-host/index.md',
    ),
    src('S7', 'Kubernetes page: "Coming soon"', 'https://raw.githubusercontent.com/retracedhq/docs/main/self-host/kubernetes.md'),
    src(
      'S8',
      'No hosted service or pricing found. boxyhq.com redirects to ory.sh, and the Ory pricing page doesn\'t list Retraced. A 2024 Ory changelog post says "Audit logs are currently a self-hosted only feature".',
      'https://www.ory.com/pricing',
      ['https://www.ory.com/blog/changelog-saml-jackson-2024'],
    ),
    src(
      'S9',
      'Publisher API docs: mandatory `action`, `crud`, `actor`',
      'https://raw.githubusercontent.com/retracedhq/docs/main/apis/publisher-api.md',
    ),
    src(
      'S10',
      'API spec `CreateEventRequest`: required `action`, `crud`; optional `group`, `actor`, `target` and more',
      'https://raw.githubusercontent.com/retracedhq/retraced/main/swagger.json',
    ),
    src('S11', 'GraphQL search endpoints', 'https://raw.githubusercontent.com/retracedhq/docs/main/apis/graphql.md'),
    src('S12', 'Search syntax', 'https://raw.githubusercontent.com/retracedhq/docs/main/getting-started/searching-for-events.md'),
    src(
      'S13',
      'Environment variables: Postgres, Elasticsearch, NSQ, `PG_SEARCH`; no retention settings',
      'https://raw.githubusercontent.com/retracedhq/docs/main/self-host/env-variables.md',
    ),
    src(
      'S14',
      'Embedded viewer: `@retracedhq/logs-viewer`, `RetracedEventsBrowser`, group-scoped viewer token',
      'https://raw.githubusercontent.com/retracedhq/docs/main/getting-started/embedded-viewer.md',
    ),
    src('S15', 'Enterprise API', 'https://raw.githubusercontent.com/retracedhq/docs/main/exposing-retraced-data/enterprise-api.md'),
    src('S16', 'Releases: v1.13.1, published 2024-11-06', 'https://api.github.com/repos/retracedhq/retraced/releases'),
    src('S17', 'Commits: latest on `main` 2025-08-26; `archived: false`', 'https://api.github.com/repos/retracedhq/retraced/commits', [
      'https://api.github.com/repos/retracedhq/retraced',
    ]),
  ],
  unverified:
    "Who maintains Retraced today (boxyhq.com now redirects to Ory, and we found no statement from Ory about Retraced); whether OpenSearch or the repository's Helm files are supported; any retention or deletion job outside the documented configuration; CSV export details.",
};

const workos: Comparison = {
  slug: 'workos-audit-logs',
  path: '/compare/workos-audit-logs',
  name: 'WorkOS Audit Logs',
  title: 'Logbird and WorkOS Audit Logs',
  summary:
    "WorkOS Audit Logs is a hosted service for recording what users do in your product and handing that record to your enterprise customers. You define a schema for each action, send events to the WorkOS API, and your customers' IT admins can view and export them through the WorkOS Admin Portal. Events can also stream to Datadog, Splunk, S3, Google Cloud Storage, Microsoft Sentinel, Snowflake or any HTTPS endpoint. If your customers' IT teams expect to browse and export audit logs themselves, it covers that out of the box.",
  summarySourceIds: range('W', 1, 5),
  card: "A hosted audit log API with an Admin Portal viewer for your customers' IT admins, and streaming to SIEM tools.",
  fit: "Your enterprise customers' IT admins need a ready-made portal and SIEM streams today, and you'd rather not run any infrastructure.",
  rows: [
    { label: 'Licence and source', logbird: LOGBIRD_SOURCE, them: 'No source code or licence published', sourceIds: ['W1', 'W2'] },
    {
      label: 'Self-host',
      logbird: LOGBIRD_SELF_HOST,
      them: "No self-host option documented. The on-prem guide covers your app calling WorkOS's cloud.",
      sourceIds: ['W6'],
    },
    { label: 'Hosting model', logbird: LOGBIRD_HOSTING, them: 'Hosted by WorkOS', sourceIds: ['W2'] },
    {
      label: 'Schema',
      logbird: 'Any JSON with an `action`; nothing to register',
      them: 'Event schemas must be configured per action before you emit; metadata JSON Schema validation is optional',
      sourceIds: ['W2', 'W7', 'W8'],
    },
    {
      label: 'Required event fields',
      logbird: '`action`',
      them: '`organization_id`, `action`, `occurred_at`, `actor`, `targets`, `context`',
      sourceIds: ['W9'],
    },
    {
      label: 'Search',
      logbird: 'Query language and guarded SQL `WHERE` mode in the console',
      them: 'Filter by actors, events, targets and dates in the Dashboard and Admin Portal',
      sourceIds: ['W1', 'W2'],
    },
    {
      label: 'Export',
      logbird: 'CSV or JSONL from the explorer',
      them: 'CSV export through the Dashboard and the API, one organization and date range at a time, covering the past three months',
      sourceIds: ['W10'],
    },
    { label: 'Streaming to SIEM', logbird: 'On the roadmap', them: 'Log Streams to seven destination types', sourceIds: ['W5'] },
    {
      label: 'Retention',
      logbird: 'Per project, 7 days to 10 years; can be lowered, with a preview and permanent deletion',
      them: "Per organization; 30 days by default; can be raised up to 10 years; lowering isn't supported",
      sourceIds: ['W2', 'W11'],
    },
    { label: 'Customer-facing viewer', logbird: LOGBIRD_VIEWER, them: 'Admin Portal: view and export events', sourceIds: ['W3'] },
    {
      label: 'Programmatic read',
      logbird: LOGBIRD_READ,
      them: "Export API; Widgets GraphQL API to search one organization's events",
      sourceIds: ['W10', 'W12'],
    },
    { label: 'Storage engine', logbird: LOGBIRD_STORAGE, them: 'Not stated in public docs', sourceIds: [] },
    {
      label: 'Pricing',
      logbird: LOGBIRD_PRICING,
      them: '$0/month listed on the product page; $125/month per SIEM connection; $99/month per million events stored (as of 2026-11-07)',
      sourceIds: ['W1', 'W13'],
    },
  ],
  chooseThem: [
    "Your enterprise customers' **IT admins need to view and export their own audit logs** today, through a ready-made portal.",
    'You need **log streams to a SIEM** (Datadog, Splunk, Sentinel, S3 and others) now.',
    'You want **strongly typed events**, validated against a schema for each action.',
    "You'd rather **not run any infrastructure**, and you already use WorkOS for other features.",
  ],
  chooseLogbird: [
    'Your audit data must **stay on your own servers**, or you want to read and change the code.',
    'You want to **start sending without defining schemas first**, and add fields over time.',
    'Your team needs an **operator console**: search with a query language or SQL, entity pages, operation trees, workers and retries.',
    'You need to **lower retention**, not only raise it, and see what will be deleted before it happens.',
  ],
  sources: [
    src(
      'W1',
      'Product page: "Advanced event logging, auditing, and exporting for IT admins"; filtering; pricing lines',
      'https://workos.com/audit-logs',
    ),
    src(
      'W2',
      'Docs overview: event structure, schemas required before emitting, Dashboard viewing, retention defaults',
      'https://workos.com/docs/audit-logs',
    ),
    src('W3', 'Admin Portal: "Users will be able to view and export Audit Log events…"', 'https://workos.com/docs/audit-logs/admin-portal'),
    src('W4', 'Platform Audit Logs (optional WorkOS-emitted events)', 'https://workos.com/docs/audit-logs/platform-audit-logs'),
    src(
      'W5',
      'Log Streams: Datadog, Splunk, AWS S3, Google Cloud Storage, Microsoft Sentinel, Snowflake, Generic HTTPS',
      'https://workos.com/docs/audit-logs/log-streams',
    ),
    src('W6', 'On-prem deployment guide', 'https://workos.com/docs/on-prem-deployment'),
    src('W7', 'Create schema API', 'https://workos.com/docs/reference/audit-logs/schema/create'),
    src('W8', 'Metadata schema: optional validation', 'https://workos.com/docs/audit-logs/metadata-schema'),
    src('W9', 'Create event API: required fields', 'https://workos.com/docs/reference/audit-logs/event/create'),
    src('W10', 'Exporting events: single organization, date range, past three months', 'https://workos.com/docs/audit-logs/exporting-events', [
      'https://workos.com/docs/reference/audit-logs/export',
    ]),
    src('W11', 'Set retention API: `1_MONTH` to `11_MONTHS`, `1_YEAR` to `10_YEARS`', 'https://workos.com/docs/reference/audit-logs/retention/set'),
    src('W12', 'Widgets API, audit events (GraphQL)', 'https://workos.com/docs/widgets-api/audit-logs/audit-events.md'),
    src('W13', 'Pricing page, Audit Logs section', 'https://workos.com/pricing'),
  ],
  unverified:
    'Whether `context.location`, `context.user_agent` and actor or target sub-fields are each required; how the per-million-events charge relates to the 30-day default; event size and rate limits; Admin Portal link expiry and filter options; whether the Widgets GraphQL API is generally available; storage engine and data-residency options.',
};

const pangea: Comparison = {
  slug: 'pangea',
  path: '/compare/pangea',
  name: 'Pangea Secure Audit Log',
  title: 'Logbird and Pangea Secure Audit Log',
  summary:
    "Pangea Secure Audit Log is a managed service built around tamper evidence. Every event goes into a Merkle tree. Pangea publishes the tree's root hashes to Arweave, a public, append-only ledger, and every search result can come with a proof that it hasn't been altered. Events can also be signed. Logs move through hot, warm and cold storage, and an embeddable React viewer lets your customers search and verify their logs. If you need to *prove* that logs weren't changed, that's what it was built for, and Logbird doesn't do it.",
  summarySourceIds: range('P', 1, 4),
  note: {
    kind: 'status',
    title: 'Ownership, as of 7 November 2026',
    body: "As of 7 November 2026: CrowdStrike completed its acquisition of Pangea on 26 September 2025, and Pangea's product and signup pages redirect to CrowdStrike, while the Secure Audit Log documentation and API are still published. Check current availability with CrowdStrike.",
    sourceIds: ['P5', 'P6', 'P7'],
  },
  card: 'A hosted, tamperproof audit log with cryptographic proofs. Part of CrowdStrike since September 2025.',
  fit: "You need cryptographic proof that audit events haven't been changed.",
  rows: [
    {
      label: 'Licence and source',
      logbird: 'MIT',
      them: 'Hosted service, no source published; SDKs and the viewer component are MIT',
      sourceIds: ['P8', 'P9'],
    },
    {
      label: 'Self-host',
      logbird: LOGBIRD_SELF_HOST,
      them: "No self-host option documented; Pangea's Edge and Private Cloud models don't list the audit service",
      sourceIds: ['P10', 'P11'],
    },
    { label: 'Hosting model', logbird: LOGBIRD_HOSTING, them: 'Hosted by Pangea', sourceIds: ['P12'] },
    {
      label: 'Schema',
      logbird: 'Any JSON with an `action`; recommended envelope',
      them: "Templates (for example Timestamp, Actor, Action, Status, Target, Source, Tenant ID, Old, New, Message) or a custom schema per configuration; the schema can't change after creation",
      sourceIds: ['P13'],
    },
    {
      label: 'Tamper evidence',
      logbird: 'None',
      them: 'Merkle-tree tamperproofing, roots published to Arweave, optional event signing',
      sourceIds: ['P2'],
    },
    {
      label: 'Search',
      logbird: 'Query language and guarded SQL `WHERE` mode',
      them: '`field:value` with `AND`, `OR`, parentheses and quotes; up to 10,000 results per search',
      sourceIds: ['P14', 'P12'],
    },
    {
      label: 'Retention',
      logbird: 'Per project, 7 days to 10 years; hourly permanent deletion',
      them: 'Hot up to 14 days, warm up to 10 years, cold up to 10 years (cold retrievable on request)',
      sourceIds: ['P15'],
    },
    {
      label: 'Customer-facing viewer',
      logbird: LOGBIRD_VIEWER,
      them: 'Embeddable React component, `@pangeacyber/react-mui-audit-log-viewer`, wired to your backend',
      sourceIds: ['P9'],
    },
    { label: 'Storage engine', logbird: LOGBIRD_STORAGE, them: 'Not stated in public docs', sourceIds: [] },
    {
      label: 'Pricing',
      logbird: LOGBIRD_PRICING,
      them: 'No public price list; signup redirects to CrowdStrike',
      sourceIds: ['P7', 'P16'],
    },
  ],
  chooseThem: [
    "You need **cryptographic proof** that audit events haven't been changed, with verifiable published roots.",
    'You want **event signing** with managed or imported keys.',
    'You want a **ready-made, embeddable viewer** that also verifies integrity.',
    "You want **tiered storage** for very long retention and don't need to self-host.",
  ],
  chooseLogbird: [
    'Your events must **stay on your own servers**, under an MIT licence.',
    'You want to **send any shape** without designing a fixed schema first.',
    'Your team investigates with an **operator console**: entity pages, operation trees, workers and retries, and SQL.',
    GITHUB_PUBLIC
      ? 'You want **SQL-level questions** answered against your own ClickHouse, under limits you can read in the code.'
      : 'You want **SQL-level questions** answered against your own ClickHouse, under documented limits.',
  ],
  sources: [
    src(
      'P1',
      'About: "transparent, immutable, and cryptographically verifiable tamperproof audit logging"',
      'https://pangea.cloud/docs/audit/overview/about',
    ),
    src(
      'P2',
      'Tamperproofing: Merkle trees, roots published to Arweave, membership and consistency proofs, signing',
      'https://pangea.cloud/docs/audit/about-tamperproofing',
    ),
    src('P3', 'Secure Audit Log docs home', 'https://pangea.cloud/docs/audit/'),
    src('P4', 'Settings: log signing, retention tiers', 'https://pangea.cloud/docs/audit/getting-started/settings'),
    src(
      'P5',
      'CrowdStrike press release, 16 Sep 2025: agreement to acquire Pangea',
      'https://www.crowdstrike.com/en-us/press-releases/crowdstrike-to-acquire-pangea-to-secure-every-layer-of-enterprise-ai/',
    ),
    src(
      'P6',
      'CrowdStrike FY2026 10-K: acquisition completed 26 Sep 2025',
      'https://www.sec.gov/Archives/edgar/data/1535527/000153552726000010/crwd-20260131.htm',
    ),
    src(
      'P7',
      '`pangea.cloud/services/secure-audit-log/` and `/signup/` return 301 redirects to this CrowdStrike page (checked by HTTP request)',
      'https://www.crowdstrike.com/en-us/platform/falcon-aidr-ai-detection-and-response/',
    ),
    src('P8', 'SDK repositories (licence field: MIT)', 'https://github.com/pangeacyber'),
    src('P9', 'React viewer docs and package', 'https://pangea.cloud/docs/libraries/react-mui-audit-log-viewer/', [
      'https://github.com/pangeacyber/pangea-javascript/tree/main/packages/react-mui-audit-log-viewer',
    ]),
    src('P10', 'Deployment models', 'https://pangea.cloud/docs/deployment-models/', ['https://pangea.cloud/docs/deployment-models/edge']),
    src('P11', 'Private Cloud', 'https://pangea.cloud/docs/deployment-models/private-cloud'),
    src('P12', 'API reference: base URL, `/v2/log` (1–1000 events), search limits', 'https://pangea.cloud/docs/api/audit/'),
    src('P13', 'Configuration and schemas', 'https://pangea.cloud/docs/audit/getting-started/configuration'),
    src('P14', 'Searching the logs', 'https://pangea.cloud/docs/audit/using-secure-audit-log/searching-the-logs'),
    src('P15', 'Retention tiers (same page as P4); cold export', 'https://pangea.cloud/docs/audit/using-secure-audit-log/cold-export'),
    src(
      'P16',
      'Billing page: renders no price list ("Loading billing information…")',
      'https://pangea.cloud/docs/admin-guide/organizations/billing/',
    ),
  ],
  unverified:
    "Whether CrowdStrike still sells Secure Audit Log to new customers; the pricing model (the public billing page describes credit-based pay-as-you-go with a monthly credit, but doesn't render the figures, which exist only in the page's script source, and signup now redirects to CrowdStrike); the signing and hash algorithms; the storage engine; whether `message` is required in the default template.",
};

const bemi: Comparison = {
  slug: 'bemi',
  path: '/compare/bemi',
  name: 'Bemi',
  title: 'Logbird and Bemi',
  summary:
    "Bemi is a different kind of tool. It connects to your Postgres write-ahead log and records every row change automatically: the table, the primary key, the operation, and the row before and after. Its ORM packages attach application context, such as the user or the endpoint, to each change. You don't instrument call sites, and nothing is missed because someone forgot an `audit()` call. Logbird works the other way round: your code reports actions, including ones that never touch your database.",
  summarySourceIds: range('B', 1, 4),
  note: {
    kind: 'category',
    title: 'A different category',
    body: 'Bemi is automatic database change data capture for Postgres. Logbird is an application audit log. Many teams could use both: Bemi as the record of every row change, and Logbird as the readable history of who did what.',
    sourceIds: [],
  },
  card: 'A different category: automatic change capture for Postgres. Records every row change without instrumenting your code.',
  fit: 'You want every Postgres row change captured automatically, without instrumenting your code.',
  rows: [
    {
      label: 'What it records',
      logbird: 'Actions your code reports, in any shape',
      them: 'Every insert, update and delete in tracked Postgres tables',
      sourceIds: ['B1', 'B3'],
    },
    {
      label: 'How it captures',
      logbird: 'SDK or HTTP calls you add',
      them: 'Postgres logical replication (WAL), through Debezium and NATS JetStream',
      sourceIds: ['B1', 'B5'],
    },
    { label: 'Databases', logbird: "Any; Logbird doesn't read your database", them: 'PostgreSQL', sourceIds: ['B4', 'B5'] },
    { label: 'Licence', logbird: 'MIT', them: 'Core: SSPL-1.0; ORM packages: LGPL-3.0', sourceIds: ['B6', 'B7', 'B8'] },
    {
      label: 'Self-host',
      logbird: LOGBIRD_SELF_HOST,
      them: 'Open-source version "designed for evaluation and non-critical workloads"; a licensed Self-Hosting Enterprise edition for production',
      sourceIds: ['B9'],
    },
    { label: 'Hosted offering', logbird: LOGBIRD_HOSTED_OFFERING, them: 'Bemi Cloud', sourceIds: ['B9'] },
    {
      label: 'Data model',
      logbird: 'Recommended envelope: actor, executor, tenant, targets, changes, operation',
      them: '`changes` table: database, schema, table, primary key, operation, before, after, context',
      sourceIds: ['B3'],
    },
    {
      label: 'Query',
      logbird: 'Query language and guarded SQL `WHERE` mode in a console',
      them: 'SQL on the `changes` table, or ORM helpers (Prisma, Rails and others)',
      sourceIds: ['B3', 'B10', 'B11'],
    },
    {
      label: 'Retention',
      logbird: 'Per project, 7 days to 10 years; hourly permanent deletion; self-host included',
      them: 'Automatic retention in Bemi Cloud; not included in the open-source self-hosted version',
      sourceIds: ['B3', 'B9'],
    },
    { label: 'Storage engine', logbird: LOGBIRD_STORAGE, them: 'PostgreSQL', sourceIds: ['B3'] },
    {
      label: 'Pricing',
      logbird: LOGBIRD_PRICING,
      them: 'Starter $19/month, Business from $99/month, Enterprise custom (as listed on bemi.io on 2026-11-07)',
      sourceIds: ['B12'],
    },
  ],
  chooseThem: [
    'You want **every row change in Postgres captured automatically**, without touching hundreds of call sites.',
    "You need **before-and-after rows** for every change, including ones made by scripts or migrations outside your app's code paths.",
    'You want to **query history from your ORM**, next to your data.',
  ],
  chooseLogbird: [
    'You want to record **actions, not rows**: a sign-in, a denied request, a failed payment, an export, or work done in a queue worker that touches no table.',
    'Your data lives in **more than one store**, or not in Postgres.',
    'You need the **actor, the executor and the impersonator** on each event, with operation trees across requests and jobs.',
    'You want **an MIT-licensed, self-hosted** audit log with retention controls included.',
  ],
  sources: [
    src(
      'B1',
      'README: tracks changes by connecting to the WAL using Change Data Capture; no table alterations (github.com/BemiHQ/bemi now redirects to github.com/pgstack-io/bemi-io)',
      'https://github.com/BemiHQ/bemi',
    ),
    src('B2', 'Website: "Automatic Audit Trail for Postgres"', 'https://bemi.io'),
    src(
      'B3',
      'Destination database: `changes` table columns; Cloud retention; storage in PostgreSQL',
      'https://docs.bemi.io/postgresql/destination-database',
    ),
    src('B4', 'Docs home: "plugs into PostgreSQL and ORMs to track database changes automatically"', 'https://docs.bemi.io'),
    src('B5', 'Source database: `wal_level = logical`, replication slot and publication', 'https://docs.bemi.io/postgresql/source-database'),
    src('B6', 'Core licence file: Server Side Public License, version 1', 'https://github.com/pgstack-io/bemi-io/blob/main/LICENSE'),
    src('B7', '`bemi-prisma` licence file: LGPL-3.0', 'https://raw.githubusercontent.com/pgstack-io/bemi-prisma/main/LICENSE'),
    src('B8', '`bemi-rails` README: "Distributed under the terms of the LGPL-3.0 License"', 'https://github.com/pgstack-io/bemi-rails'),
    src('B9', 'Self-hosting: open-source version and Self-Hosting Enterprise; Cloud-only features', 'https://docs.bemi.io/self-hosting'),
    src('B10', 'Prisma integration', 'https://docs.bemi.io/orms/prisma'),
    src('B11', 'Rails integration', 'https://docs.bemi.io/orms/rails'),
    src('B12', 'Pricing', 'https://bemi.io/pricing'),
  ],
  unverified:
    'Bemi\'s GitHub organization now redirects to `pgstack-io` (PgStack, from the same company, Bemi Technologies, Inc.), and pgstack.io lists a change-tracking product called "Audit" with different pricing. We found no announcement explaining the relationship, so this page describes Bemi as published on bemi.io and docs.bemi.io. Also unverified: which retention periods currently apply (the docs and the PgStack pricing page differ); supported PostgreSQL versions; whether a customer-facing viewer exists; licence files of the other ORM packages.',
};

/** In the order of marketing/copy/compare/README.md. */
export const comparisons: Comparison[] = [retraced, workos, pangea, bemi];

export function getComparison(slug: Comparison['slug']): Comparison {
  const comparison = comparisons.find((entry) => entry.slug === slug);
  if (!comparison) {
    throw new Error(`Unknown comparison: ${slug}`);
  }
  return comparison;
}

/** `2026-11-07` → `7 November 2026`, without Intl so server and client always agree. */
export function longDate(iso: string): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${months[(month ?? 1) - 1]} ${year}`;
}
