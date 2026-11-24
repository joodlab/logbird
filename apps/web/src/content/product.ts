/**
 * Words and samples of /product. Brief: marketing/copy/product.md. Inline marks: `code` and **bold**
 * (components/marketing/rich.tsx). The roadmap list is content/roadmap.ts.
 */
const searchSample = `actor:usr_42 action:booking.* -env:staging
outcome:(failure OR denied) attempt:>2
tenant.name:"Azure Hotels" occurredAt:>now-7d
impersonator:*  metadata.channel:whatsapp`;

const readSample = `import { readAuditTrail, trailQuery } from '@logbird/sdk/read';

// Server only. First check that the signed-in user may see this booking.
const page = await readAuditTrail(
  { endpoint: process.env.LOGBIRD_ENDPOINT!, readKey: process.env.LOGBIRD_READ_KEY! },
  trailQuery({
    target: { type: 'booking', id: 'bk_1042' },
    tenant: 'biz_7',
    range: { from: '2026-01-01T00:00:00Z', to: new Date().toISOString() },
  }),
);
// Keep only events where one target is this booking (type and id on the same target).
const events = page.data.filter((event) => event.targets.some((t) => t.type === 'booking' && t.id === 'bk_1042'));
// page.nextCursor: pass back as \`cursor\` for the next page`;

/** One delivery as the receiver sees it: docs/SPEC.md § "Webhook endpoint management" (body, headers, `lb1_` ids). */
const webhookSample = `POST https://example.com/webhooks/logbird
Content-Type: application/json
webhook-id: lb1_…
webhook-timestamp: 1795430400
webhook-signature: v1,…

{ "id": "evt_cancel_bk_1042", "action": "booking.cancelled", … }`;

export const product = {
  samples: { searchSample, readSample, webhookSample },
  hero: {
    eyebrow: 'Product',
    title: 'Everything your team needs to answer "who did what".',
    lead: 'The Logbird console is for the people who operate your product: engineers on call, support, and whoever answers the auditor. It is not a portal for your end customers. To show history inside your own product, use the read API.',
  },
  overview: {
    label: 'The console overview',
    frameLabel: 'Overview',
    caption: 'The overview: events by outcome, the most frequent actions, and a setup checklist until your integration is complete.',
  },
  toc: {
    label: 'On this page',
    items: [
      ['explorer', 'Explorer'],
      ['search', 'Search'],
      ['sql-mode', 'SQL mode'],
      ['entities', 'Entity pages'],
      ['operations', 'Operations'],
      ['event-detail', 'Event detail'],
      ['setup', 'Setup'],
      ['retention', 'Retention'],
      ['read-api', 'Read API'],
      ['webhooks', 'Webhooks'],
    ],
  },
  explorer: {
    eyebrow: 'Explorer',
    title: 'Every event, in one table.',
    body: 'Pick a time range, type a query, and narrow it down with facets. Drag across the chart to zoom. Click a row to open the full event. The query, time range and columns live in the URL, so a link opens the same search for a teammate. A relative range such as the last hour resolves when they open it. Share an absolute range to preserve the time window, or a downloaded export to preserve the results.',
    bullets: ['Facets with counts: click to include, Alt-click to exclude.', 'Configurable columns and infinite scroll.'],
    /** The keyboard bullet: each key in a <kbd>, followed by its text. */
    keyboard: {
      lead: 'Keyboard first: ',
      keys: [
        ['/', ' focuses search, '],
        ['j', ' and '],
        ['k', ' move through events, '],
        ['Esc', ' closes the panel, '],
        ['⌘K', ' opens the command palette.'],
      ],
    },
    lastBullet: 'Export the current results as CSV or JSONL.',
    clipLabel: 'Explorer',
    clipCaption: 'Type a query, open an event, follow its operation.',
  },
  search: {
    eyebrow: 'Search',
    title: 'A query language you already half know.',
    body: "Type `field:value` and Logbird suggests fields and values as you go. It covers what you'd expect from Lucene-style search: wildcards, negation, ranges, regex and groups. If you type KQL-style syntax like `f = v`, it offers to convert it.",
    bullets: [
      'Fields are suggested from what your project actually sends, with how often each one appears.',
      'Errors point at the exact token and say what was expected, for example "attempt is a number".',
      'Nested fields are searchable by their dotted path, up to 6 levels deep. Each event indexes up to 256 custom attributes, text values indexed up to their first 2 KiB (a number too long to index stays in the event JSON). Search limits apply to the index. You can inspect the full parsed event as JSON.',
    ],
    codeTitle: 'Query language',
    frameLabel: 'Search',
    caption: 'Value suggestions with counts, and the operators that fit the field.',
  },
  sql: {
    eyebrow: 'SQL mode',
    /** "Or write a SQL `WHERE` expression, safely.", in parts: the heading styles its code span itself. */
    title: { before: 'Or write a SQL ', code: 'WHERE', after: ' expression, safely.' },
    body: "Switch the bar to SQL and write a ClickHouse boolean expression, such as `job_attempt > 2 AND attributes['metadata.channel'] = 'whatsapp'`. You write only the condition. Logbird writes the rest of the statement.",
    frameLabel: 'SQL mode',
    caption: 'A subquery, rejected inline before anything runs.',
    guardLabel: (n: number) => `Guard ${n}`,
    guards: [
      ['Parsed by ClickHouse', "Logbird asks ClickHouse for the expression's syntax tree and checks it before running anything."],
      [
        'Allowlisted',
        'Only known columns and a fixed list of functions are allowed. Subqueries, joins, table functions, SETTINGS and system tables are rejected.',
      ],
      ['Run as a restricted user', 'Queries run as a separate read-only ClickHouse user with its own CPU, memory and row limits.'],
      ['Scoped to your project', "Database row policies limit that user to the project you're looking at, even if the expression is 1 OR 1."],
    ],
    note: "SQL mode is for the console only. The public read API accepts the query language, not SQL. A free-form SQL console isn't part of Logbird.",
  },
  entities: {
    eyebrow: 'Follow anything',
    title: 'A page for each actor, tenant, worker and record.',
    body: 'Actors, tenants, executors and records in your events get their own pages (records from the first 64 targets of each event). Each one shows an activity chart, its top actions, its outcome split, related entities and a full timeline. Directory pages list them all, most active first, with fuzzy search.',
    bullets: [
      '**Actors:** who caused it. Users, API keys, integrations, the system.',
      '**Tenants:** whose account. "What happened at Azure Hotels last week?" is one click.',
      '**Executors:** what did the work. The API, each queue worker and cron job, with job ids and attempts.',
      '**Records:** what changed. `booking:bk_1042` has a history of its own.',
    ],
    frameLabel: 'Tenant',
    caption: "A tenant's page: event counts, what support did while signed in as the customer, and its history with a chart and every event.",
  },
  operations: {
    eyebrow: 'Operation trees',
    title: 'One request, every job it started, as a single tree.',
    body: 'Send the same `operationId` on a request and the jobs it starts. Add `parentEventId` to say which event caused which. Logbird draws the tree: each step with its outcome, executor and timing. A failed first attempt and the retry that worked sit side by side.',
    frameLabel: 'Operation',
    caption: 'An operation tree: a scheduler request, the jobs it started, failed attempts and the retries that worked.',
  },
  eventDetail: {
    eyebrow: 'Event detail',
    title: 'The full story of one event.',
    body: 'Open any event to read it as a sentence: who did what, in which account, to which records, and how it ended. The actor and the executor are on separate cards. When a support agent acted for a customer, the agent appears beside the customer.',
    bullets: [
      'The before and after values you send, for the first 256 changes.',
      'The causation breadcrumb, with a link to the whole operation.',
      'Context ids (request, trace, IP), the indexed attributes, and the full parsed event as JSON.',
      'Copy a link, or copy the event as a curl command.',
      'Support work stands out: rows show "via support", the Done by support filter lists them, and each support agent has a page.',
    ],
    frameLabel: 'Event detail',
    caption: 'An event in detail: actor and executor, tenant, targets, the status change and the causation chain.',
  },
  more: {
    title: 'And the parts you use every day.',
    items: [
      {
        id: 'live-tail',
        eyebrow: 'Live',
        title: 'Watch events arrive during a deploy.',
        body: 'Turn on Live and new events appear at the top of the table as they arrive, with your current query still applied.',
        limit: "Live tail polls over HTTP. It doesn't use WebSockets, so it works behind any proxy.",
      },
      {
        id: 'saved-views',
        eyebrow: 'Saved views',
        title: 'Save the searches your team runs every week.',
        body: "Save a query, its time range and its columns as a view, in query or SQL mode. Views appear in the sidebar and in the search bar's suggestions. Anyone in the workspace can open them; members can delete their own.",
      },
      {
        id: 'workspace-activity',
        eyebrow: 'Workspace activity',
        title: 'Logbird records its own management actions.',
        body: 'Logbird records management actions (projects, keys, retention, invitations) in workspace activity. You read it with the same explorer.',
      },
      {
        id: 'team',
        eyebrow: 'Workspaces and roles',
        title: 'Owners and admins manage it. Members use it.',
        body: 'Sign-in is by emailed one-time code. There are no passwords. Owners and admins manage projects, keys, retention and invitations. Members search, export, save views and read workspace activity. The server checks every role on every request.',
        limit: "SSO isn't available yet. It's on the roadmap.",
      },
    ],
  },
  setup: {
    eyebrow: 'Setup that checks itself',
    title: "The setup page tells you what's still missing.",
    body: 'Send your first event and the setup page notices on its own. It then checks your integration against your real events: for actors, tenants, executors and targets it shows the coverage and links to the events missing each one; for operation ids it shows the coverage and links to the events that have one. Reviewing retention and inviting your team are separate checklist items.',
    bullets: [
      'Onboarding picks up where you left off.',
      '"Send a test event" and "Load sample data" show the console before you integrate. Sample data is 2000 fictional events over seven days; it never counts as setup, and you can remove it.',
      'A conformance score on every event, and a Fields page that shows coverage for the single-value core fields and the attributes your events carry in the selected range.',
    ],
    frameLabel: 'Setup',
    caption: 'The setup page checks each part of the integration against the events it has received.',
  },
  retention: {
    eyebrow: 'Retention',
    title: 'Keep events as long as you decide, then delete them.',
    body: "Each project keeps events for a window you choose, from 7 days to 10 years. New projects start at 90 days. A worker deletes expired events every hour. Before you lower the window, Logbird shows how many events will be deleted. To confirm, you type the project's slug, and the purge starts right away.",
    limit: "Retention deletes are permanent. There's no archive and no undo. The count can change between preview and deletion.",
    frameLabel: 'Retention',
    caption: "A project's retention settings: the current window, the policies you can choose, and when the purge last ran.",
  },
  readApi: {
    eyebrow: 'Read API',
    title: 'Show history inside your own product.',
    body: 'Give your customers a "History" tab. Your backend calls `GET /v1/events` with a read key and a query for that record and tenant, and checks that each returned event names that record, then returns the page to your UI. Results are paginated with a cursor. The Vue, Nuxt and TanStack Start packages include helpers for this.',
    limit:
      'A read key can read the whole project. Your backend must check that the person asking may see that tenant or record, on every page it fetches.',
    codeTitle: 'Your backend',
    developersLink: 'Read API on the developer page',
  },
  // DELIVERY WINDOW (T2 #359): before this PR merges, add one sentence from T2's merged docs here, saying events that arrive later than the window are skipped by the webhook and stay stored and searchable.
  webhooks: {
    eyebrow: 'Webhooks',
    title: 'Send matching events to your own endpoint.',
    body: 'Logbird sends each matching event to an HTTPS endpoint you choose. Choose which events with the same query language as the explorer, and narrow an endpoint to one tenant or one record, with field masks. Every delivery is signed with the Standard Webhooks headers; verify it with the TypeScript or .NET SDK.',
    bullets: [
      'Network failures, timeouts and responses other than `2xx` or `410 Gone` are retried with backoff for up to 24 hours. Delivery is at least once, so deduplicate by `webhook-id`.',
      "A delivery log shows each delivery's status and its recent attempts for 30 days; resend a delivery or send a test ping.",
      'The secret is shown once; rotate it with an overlap so receivers can switch.',
      "An endpoint is disabled at once when it answers `410 Gone`, and after 50 consecutive failed deliveries (by default) or 24 hours of failures without a success. An email notice is then queued for the workspace's owners and admins.",
    ],
    limit:
      'At least once, not exactly once, and in no guaranteed order. A delivery that still fails after 24 hours stops. Up to 10 endpoints per project; HTTPS only.',
    codeTitle: 'A delivery',
  },
} as const;
