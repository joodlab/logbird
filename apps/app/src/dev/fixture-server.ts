/**
 * DEV-ONLY fixture server. Answers the same URLs as apps/server (contracts route table +
 * the better-auth endpoints the console uses) from an in-memory, deterministic JoodCMS-shaped
 * dataset. Loaded only when `VITE_FIXTURES=1` in dev — see src/lib/api/transport.ts.
 *
 * Sign in as demo@trailmark.local (workspace "Jood" with seeded projects) or any other email
 * to walk onboarding from scratch. The one-time code is always 424242.
 */
import type { ApiKey, AuditEvent, EntityKind, Project, SavedView } from '@trailmark/contracts';
import { RETENTION_OPTIONS } from '@trailmark/contracts';
import { EventStore, entityIndex, facets, fields, histogram, overview, profile } from './engine';
import { createJoodGenerator, createLedgerGenerator, type Generator } from './joodcms';
import { normalize, type StoredEvent } from './normalize';
import { Rng, ulid } from './rng';

export const FIXTURE_OTP = '424242';
export const DEMO_EMAIL = 'demo@trailmark.local';
const STORAGE_KEY = 'trailmark.fixtures.v1';
const DAY = 86_400_000;

interface FixtureUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  createdAt: string;
}
interface Member {
  id: string;
  userId: string;
  role: string;
  createdAt: string;
}
interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  inviterId: string;
  createdAt: string;
}
interface Org {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  members: Member[];
  invitations: Invitation[];
}
type StoredProject = Omit<Project, 'lastEventAt' | 'eventsLast24h'> & { seed?: 'jood' | 'ledger' };
interface RetentionRun {
  startedAt: string;
  finishedAt: string | null;
  status: string;
  cutoff: string;
  error: string | null;
}

interface State {
  session: { userId: string; token: string } | null;
  users: FixtureUser[];
  orgs: Org[];
  activeOrgId: Record<string, string | null>;
  projects: StoredProject[];
  keys: ApiKey[];
  views: SavedView[];
  activity: StoredEvent[];
  customEvents: Record<string, StoredEvent[]>;
  retentionRuns: Record<string, RetentionRun>;
  seq: number;
}

const BOOT = Date.now();

function seedState(): State {
  const t = (daysAgo: number) => new Date(BOOT - daysAgo * DAY).toISOString();
  const users: FixtureUser[] = [
    { id: 'usr_demo', name: 'Demo User', email: DEMO_EMAIL, image: null, createdAt: t(46) },
    { id: 'usr_raed', name: 'Raed Al-Harbi', email: 'raed@jood.sa', image: null, createdAt: t(45) },
    { id: 'usr_lina', name: 'Lina Haddad', email: 'lina@jood.sa', image: null, createdAt: t(30) },
    { id: 'usr_omar', name: 'Omar Saleh', email: 'omar@jood.sa', image: null, createdAt: t(12) },
  ];
  const org: Org = {
    id: 'org_jood',
    name: 'Jood',
    slug: 'jood',
    createdAt: t(46),
    members: [
      { id: 'mem_1', userId: 'usr_demo', role: 'owner', createdAt: t(46) },
      { id: 'mem_2', userId: 'usr_raed', role: 'admin', createdAt: t(45) },
      { id: 'mem_3', userId: 'usr_lina', role: 'member', createdAt: t(30) },
      { id: 'mem_4', userId: 'usr_omar', role: 'member', createdAt: t(12) },
    ],
    invitations: [
      {
        id: 'inv_1',
        email: 'sami@jood.sa',
        role: 'member',
        status: 'pending',
        expiresAt: new Date(BOOT + 5 * DAY).toISOString(),
        inviterId: 'usr_demo',
        createdAt: t(2),
      },
    ],
  };
  const projects: StoredProject[] = [
    {
      id: 'prj_joodcms',
      organizationId: org.id,
      name: 'JoodCMS',
      slug: 'joodcms',
      description: 'Hotel CMS, booking engine and CRM sync — production audit trail.',
      retentionDays: 90,
      createdAt: t(46),
      seed: 'jood',
    },
    {
      id: 'prj_ledger',
      organizationId: org.id,
      name: 'Ledger demo',
      slug: 'ledger-demo',
      description: 'A small accounting app with its own vocabulary.',
      retentionDays: 30,
      createdAt: t(40),
      seed: 'ledger',
    },
  ];
  const by = (id: string, name: string) => ({ id, name });
  const keys: ApiKey[] = [
    {
      id: 'key_1',
      projectId: 'prj_joodcms',
      name: 'Production ingest',
      kind: 'ingest',
      prefix: 'tm_ingest_7Hq2',
      createdAt: t(45),
      createdBy: by('usr_demo', 'Demo User'),
      lastUsedAt: new Date(BOOT - 4000).toISOString(),
      revokedAt: null,
    },
    {
      id: 'key_2',
      projectId: 'prj_joodcms',
      name: 'Staging ingest',
      kind: 'ingest',
      prefix: 'tm_ingest_Lp9x',
      createdAt: t(44),
      createdBy: by('usr_raed', 'Raed Al-Harbi'),
      lastUsedAt: new Date(BOOT - 2 * 3_600_000).toISOString(),
      revokedAt: null,
    },
    {
      id: 'key_3',
      projectId: 'prj_joodcms',
      name: 'Support dashboard',
      kind: 'read',
      prefix: 'tm_read_c3Rk',
      createdAt: t(20),
      createdBy: by('usr_lina', 'Lina Haddad'),
      lastUsedAt: t(1),
      revokedAt: null,
    },
    {
      id: 'key_4',
      projectId: 'prj_joodcms',
      name: 'Legacy CMS key',
      kind: 'ingest',
      prefix: 'tm_ingest_Qa01',
      createdAt: t(45),
      createdBy: by('usr_raed', 'Raed Al-Harbi'),
      lastUsedAt: t(21),
      revokedAt: t(20),
    },
    {
      id: 'key_5',
      projectId: 'prj_ledger',
      name: 'Ledger ingest',
      kind: 'ingest',
      prefix: 'tm_ingest_Ld7e',
      createdAt: t(40),
      createdBy: by('usr_demo', 'Demo User'),
      lastUsedAt: new Date(BOOT - 600_000).toISOString(),
      revokedAt: null,
    },
  ];
  const view = (
    id: string,
    name: string,
    description: string,
    q: string,
    range: string,
    daysAgo: number,
    who = by('usr_demo', 'Demo User'),
  ): SavedView => ({
    id,
    projectId: 'prj_joodcms',
    name,
    description,
    state: { q, range },
    createdBy: who,
    createdAt: t(daysAgo),
  });
  const views: SavedView[] = [
    view('view_1', 'Failed CRM syncs', 'CRM jobs that failed, including retries.', 'action:crm.sync.* outcome:failure', '7d', 20),
    view(
      'view_2',
      'Impersonated actions',
      'Everything support did while impersonating a customer.',
      'impersonator:*',
      '30d',
      18,
      by('usr_lina', 'Lina Haddad'),
    ),
    view('view_3', 'Payment problems', 'Declined or failed PayFlow captures.', 'action:booking.payment.* -outcome:success', '30d', 9),
    view(
      'view_4',
      'Hotel Sunrise history',
      'Every change to Hotel Sunrise (hotel_123).',
      'target:hotel_123',
      '30d',
      4,
      by('usr_raed', 'Raed Al-Harbi'),
    ),
    view('view_5', 'Access denied', 'Permission checks that blocked someone.', 'outcome:denied', '7d', 2),
  ];
  return {
    session: null,
    users,
    orgs: [org],
    activeOrgId: { usr_demo: org.id },
    projects,
    keys,
    views,
    activity: [],
    customEvents: {},
    retentionRuns: {
      prj_joodcms: {
        startedAt: new Date(Math.floor(BOOT / 3_600_000) * 3_600_000).toISOString(),
        finishedAt: new Date(Math.floor(BOOT / 3_600_000) * 3_600_000 + 4200).toISOString(),
        status: 'succeeded',
        cutoff: new Date(Math.floor(BOOT / 3_600_000) * 3_600_000 - 90 * DAY).toISOString(),
        error: null,
      },
      prj_ledger: {
        startedAt: new Date(Math.floor(BOOT / 3_600_000) * 3_600_000).toISOString(),
        finishedAt: new Date(Math.floor(BOOT / 3_600_000) * 3_600_000 + 900).toISOString(),
        status: 'succeeded',
        cutoff: new Date(Math.floor(BOOT / 3_600_000) * 3_600_000 - 30 * DAY).toISOString(),
        error: null,
      },
    },
    seq: 100,
  };
}

function load(): State {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as State;
  } catch {
    // Corrupt or unavailable storage: start from the seed.
  }
  return seedState();
}

let state = load();
function save() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked; fixtures keep working in memory.
  }
}

/** Reset helper exposed for Playwright and the dev banner. */
export function resetFixtures(): void {
  state = seedState();
  save();
  stores.clear();
  activityStore = null;
}

/* ------------------------------------------------------------------ */
/* Event stores                                                        */
/* ------------------------------------------------------------------ */

interface LiveStore {
  store: EventStore;
  live?: Generator;
}
const stores = new Map<string, LiveStore>();

function storeFor(projectId: string): EventStore {
  let entry = stores.get(projectId);
  const project = state.projects.find((p) => p.id === projectId);
  if (!entry) {
    const store = new EventStore();
    let live: Generator | undefined;
    if (project?.seed === 'jood') {
      // 45 days of history, a busier last two hours (so "now" looks alive), then a live trickle.
      store.add(createJoodGenerator(projectId, BOOT - 45 * DAY, 560_000, 11).advance(BOOT - 2 * 3_600_000));
      store.add(createJoodGenerator(projectId, BOOT - 2 * 3_600_000, 75_000, 13).advance(BOOT));
      live = createJoodGenerator(projectId, BOOT, 8000, 12);
    } else if (project?.seed === 'ledger') {
      store.add(createLedgerGenerator(projectId, BOOT - 45 * DAY, 4_200_000, 21).advance(BOOT));
      live = createLedgerGenerator(projectId, BOOT, 120_000, 22);
    }
    store.add(state.customEvents[projectId] ?? []);
    entry = { store, live };
    stores.set(projectId, entry);
  }
  if (entry.live) entry.store.add(entry.live.advance(Date.now()));
  if (project) entry.store.purgeBefore(Date.now() - project.retentionDays * DAY);
  return entry.store;
}

let activityStore: EventStore | null = null;
function activity(): EventStore {
  if (!activityStore) {
    activityStore = new EventStore();
    activityStore.add(seedActivity());
    activityStore.add(state.activity);
  }
  return activityStore;
}

function seedActivity(): StoredEvent[] {
  const rng = new Rng(99);
  const demo = { type: 'user', id: 'usr_demo', name: 'Demo User', email: DEMO_EMAIL };
  const raed = { type: 'user', id: 'usr_raed', name: 'Raed Al-Harbi', email: 'raed@jood.sa' };
  const lina = { type: 'user', id: 'usr_lina', name: 'Lina Haddad', email: 'lina@jood.sa' };
  const items: [
    number,
    string,
    typeof demo,
    string,
    { type: string; id: string; name: string }[],
    { field: string; before?: unknown; after?: unknown }[]?,
  ][] = [
    [46, 'workspace.created', demo, 'Demo User created the workspace Jood', [{ type: 'workspace', id: 'org_jood', name: 'Jood' }]],
    [46, 'project.created', demo, 'Demo User created the project JoodCMS', [{ type: 'project', id: 'prj_joodcms', name: 'JoodCMS' }]],
    [
      45.9,
      'api_key.created',
      demo,
      'Demo User created the ingest key “Production ingest”',
      [{ type: 'api_key', id: 'key_1', name: 'Production ingest' }],
    ],
    [45, 'member.invited', demo, 'Demo User invited raed@jood.sa as admin', [{ type: 'user', id: 'usr_raed', name: 'Raed Al-Harbi' }]],
    [45, 'member.joined', raed, 'Raed Al-Harbi joined Jood', [{ type: 'user', id: 'usr_raed', name: 'Raed Al-Harbi' }]],
    [
      44,
      'api_key.created',
      raed,
      'Raed Al-Harbi created the ingest key “Staging ingest”',
      [{ type: 'api_key', id: 'key_2', name: 'Staging ingest' }],
    ],
    [40, 'project.created', demo, 'Demo User created the project Ledger demo', [{ type: 'project', id: 'prj_ledger', name: 'Ledger demo' }]],
    [
      38,
      'project.retention.changed',
      demo,
      'Demo User lowered Ledger demo retention from 90 days to 30 days',
      [{ type: 'project', id: 'prj_ledger', name: 'Ledger demo' }],
      [{ field: 'retentionDays', before: 90, after: 30 }],
    ],
    [30, 'member.joined', lina, 'Lina Haddad joined Jood', [{ type: 'user', id: 'usr_lina', name: 'Lina Haddad' }]],
    [
      20,
      'api_key.revoked',
      raed,
      'Raed Al-Harbi revoked the ingest key “Legacy CMS key”',
      [{ type: 'api_key', id: 'key_4', name: 'Legacy CMS key' }],
    ],
    [
      20,
      'api_key.created',
      lina,
      'Lina Haddad created the read key “Support dashboard”',
      [{ type: 'api_key', id: 'key_3', name: 'Support dashboard' }],
    ],
    [
      18,
      'view.created',
      lina,
      'Lina Haddad saved the view “Impersonated actions”',
      [{ type: 'saved_view', id: 'view_2', name: 'Impersonated actions' }],
    ],
    [
      12,
      'member.joined',
      { ...demo, id: 'usr_omar', name: 'Omar Saleh', email: 'omar@jood.sa' },
      'Omar Saleh joined Jood',
      [{ type: 'user', id: 'usr_omar', name: 'Omar Saleh' }],
    ],
    [
      6,
      'project.updated',
      demo,
      'Demo User updated the description of JoodCMS',
      [{ type: 'project', id: 'prj_joodcms', name: 'JoodCMS' }],
      [{ field: 'description', before: 'Hotel CMS', after: 'Hotel CMS, booking engine and CRM sync — production audit trail.' }],
    ],
    [
      4,
      'view.created',
      raed,
      'Raed Al-Harbi saved the view “Hotel Sunrise history”',
      [{ type: 'saved_view', id: 'view_4', name: 'Hotel Sunrise history' }],
    ],
    [2, 'member.invited', demo, 'Demo User invited sami@jood.sa as member', [{ type: 'invitation', id: 'inv_1', name: 'sami@jood.sa' }]],
  ];
  return items.map(([daysAgo, action, actor, description, targets, changes]) => {
    const at = BOOT - daysAgo * DAY + rng.int(0, 3_600_000);
    return normalize(
      {
        id: ulid(at, rng),
        action,
        occurredAt: new Date(at).toISOString(),
        outcome: 'success',
        severity: action.includes('revoked') || action.includes('retention') ? 'notice' : 'info',
        description,
        actor,
        executor: { type: 'api', id: 'trailmark-server', name: 'Trailmark server' },
        tenant: { id: 'org_jood', name: 'Jood' },
        targets,
        changes,
        context: { requestId: `req_${rng.alnum(10)}`, ip: '10.0.0.12' },
      },
      'workspace',
      rng.int(5, 40),
      'trailmark',
    );
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const rng = new Rng(Date.now() % 100_000);
const nextId = (prefix: string) => `${prefix}_${(++state.seq).toString(36)}${rng.alnum(4)}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}
function authError(status: number, code: string, message: string): Response {
  return json({ code, message }, status);
}

function currentUser(): FixtureUser | null {
  if (!state.session) return null;
  return state.users.find((u) => u.id === state.session?.userId) ?? null;
}
function userOrgs(user: FixtureUser): Org[] {
  return state.orgs.filter((o) => o.members.some((m) => m.userId === user.id));
}
function activeOrg(user: FixtureUser): Org | null {
  const id = state.activeOrgId[user.id];
  return userOrgs(user).find((o) => o.id === id) ?? userOrgs(user)[0] ?? null;
}
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project'
  );
}

function projectView(p: StoredProject): Project {
  const store = storeFor(p.id);
  const all = store.all();
  const dayAgo = new Date(Date.now() - DAY).toISOString();
  const { seed: _seed, ...rest } = p;
  return { ...rest, lastEventAt: all[0]?.receivedAt ?? null, eventsLast24h: all.filter((e) => e.timestamp >= dayAgo).length };
}

function recordActivity(
  user: FixtureUser,
  action: string,
  description: string,
  targets: { type: string; id: string; name: string }[],
  changes?: { field: string; before?: unknown; after?: unknown }[],
) {
  const org = activeOrg(user);
  const at = Date.now();
  const stored = normalize(
    {
      id: ulid(at, rng),
      action,
      occurredAt: new Date(at).toISOString(),
      outcome: 'success',
      severity: /revoked|retention|deleted|removed/.test(action) ? 'notice' : 'info',
      description,
      actor: { type: 'user', id: user.id, name: user.name, email: user.email },
      executor: { type: 'api', id: 'trailmark-server', name: 'Trailmark server' },
      tenant: org ? { id: org.id, name: org.name } : undefined,
      targets,
      changes,
      context: { requestId: `req_${rng.alnum(10)}`, ip: '127.0.0.1' },
    },
    'workspace',
    0,
    'trailmark',
  );
  state.activity.push(stored);
  activity().add([stored]);
}

function newSecret(kind: 'ingest' | 'read') {
  const body = rng.alnum(32);
  return { secret: `tm_${kind}_${body}`, prefix: `tm_${kind}_${body.slice(0, 4)}` };
}

function searchPage(events: AuditEvent[], url: URL) {
  const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50));
  const offset = Number(url.searchParams.get('cursor') ?? 0) || 0;
  const order = url.searchParams.get('order') ?? 'desc';
  const sorted = order === 'asc' ? [...events].reverse() : events;
  const data = sorted.slice(offset, offset + limit);
  return {
    data,
    nextCursor: offset + limit < sorted.length ? String(offset + limit) : null,
    total: sorted.length,
    tookMs: 6 + Math.round(Math.random() * 40),
  };
}

function rangeOf(url: URL): { fromMs: number; toMs: number; from: string; to: string } {
  const toMs = url.searchParams.get('to') ? Date.parse(url.searchParams.get('to') ?? '') : Date.now();
  const fromMs = url.searchParams.get('from') ? Date.parse(url.searchParams.get('from') ?? '') : toMs - DAY;
  return { fromMs, toMs, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* better-auth endpoints                                               */
/* ------------------------------------------------------------------ */

function sessionBody(user: FixtureUser) {
  const org = activeOrg(user);
  return {
    session: {
      id: 'ses_fixture',
      token: state.session?.token ?? 'fixture',
      userId: user.id,
      expiresAt: new Date(Date.now() + 7 * DAY).toISOString(),
      activeOrganizationId: org?.id ?? null,
    },
    user: { ...user, emailVerified: true, updatedAt: user.createdAt },
  };
}

function fullOrg(org: Org) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt,
    logo: null,
    metadata: null,
    members: org.members.map((m) => {
      const u = state.users.find((x) => x.id === m.userId);
      return { ...m, organizationId: org.id, user: { id: m.userId, name: u?.name ?? '', email: u?.email ?? '', image: u?.image ?? null } };
    }),
    invitations: org.invitations.map((i) => ({ ...i, organizationId: org.id })),
  };
}

async function handleAuth(path: string, method: string, body: Record<string, unknown>): Promise<Response> {
  const user = currentUser();
  switch (`${method} ${path}`) {
    case 'POST /email-otp/send-verification-otp': {
      const email = String(body.email ?? '')
        .trim()
        .toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) return authError(400, 'INVALID_EMAIL', 'Invalid email');
      return json({ success: true });
    }
    case 'POST /sign-in/email-otp': {
      const email = String(body.email ?? '')
        .trim()
        .toLowerCase();
      if (String(body.otp ?? '') !== FIXTURE_OTP) return authError(400, 'INVALID_OTP', 'Invalid OTP');
      let u = state.users.find((x) => x.email === email);
      if (!u) {
        const local = email.split('@')[0] ?? 'new';
        u = {
          id: nextId('usr'),
          name: local
            .split(/[._-]+/)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' '),
          email,
          image: null,
          createdAt: new Date().toISOString(),
        };
        state.users.push(u);
      }
      state.session = { userId: u.id, token: rng.alnum(24) };
      save();
      return json({ token: state.session.token, user: u });
    }
    case 'GET /get-session':
      return json(user ? sessionBody(user) : null);
    case 'POST /sign-out':
      state.session = null;
      save();
      return json({ success: true });
    default:
      break;
  }
  if (!user) return authError(401, 'UNAUTHORIZED', 'Unauthorized');
  switch (`${method} ${path}`) {
    case 'GET /organization/list':
      return json(userOrgs(user).map(({ members: _m, invitations: _i, ...o }) => o));
    case 'POST /organization/check-slug': {
      const taken = state.orgs.some((o) => o.slug === body.slug);
      return taken ? authError(400, 'SLUG_IS_TAKEN', 'Slug is taken') : json({ status: true });
    }
    case 'POST /organization/create': {
      const name = String(body.name ?? '').trim();
      if (name.length < 2) return authError(400, 'INVALID_NAME', 'Workspace name is too short');
      let slug = slugify(String(body.slug ?? name));
      while (state.orgs.some((o) => o.slug === slug)) slug = `${slug}-${rng.int(2, 99)}`;
      const org: Org = {
        id: nextId('org'),
        name,
        slug,
        createdAt: new Date().toISOString(),
        members: [{ id: nextId('mem'), userId: user.id, role: 'owner', createdAt: new Date().toISOString() }],
        invitations: [],
      };
      state.orgs.push(org);
      state.activeOrgId[user.id] = org.id;
      recordActivity(user, 'workspace.created', `${user.name} created the workspace ${name}`, [{ type: 'workspace', id: org.id, name }]);
      save();
      return json(fullOrg(org));
    }
    case 'POST /organization/set-active': {
      const org = userOrgs(user).find((o) => o.id === body.organizationId);
      if (!org) return authError(403, 'FORBIDDEN', 'You are not a member of this workspace');
      state.activeOrgId[user.id] = org.id;
      save();
      return json(fullOrg(org));
    }
    case 'GET /organization/get-full-organization': {
      const org = activeOrg(user);
      return json(org ? fullOrg(org) : null);
    }
    case 'POST /organization/invite-member': {
      const org = activeOrg(user);
      if (!org) return authError(400, 'NO_ACTIVE_ORGANIZATION', 'No active workspace');
      const email = String(body.email ?? '')
        .trim()
        .toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) return authError(400, 'INVALID_EMAIL', 'Invalid email');
      if (org.members.some((m) => state.users.find((u) => u.id === m.userId)?.email === email)) {
        return authError(400, 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION', 'This person is already a member of the workspace');
      }
      if (org.invitations.some((i) => i.email === email && i.status === 'pending')) {
        return authError(400, 'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION', 'This person already has a pending invitation');
      }
      const inv: Invitation = {
        id: nextId('inv'),
        email,
        role: String(body.role ?? 'member'),
        status: 'pending',
        expiresAt: new Date(Date.now() + 7 * DAY).toISOString(),
        inviterId: user.id,
        createdAt: new Date().toISOString(),
      };
      org.invitations.push(inv);
      recordActivity(user, 'member.invited', `${user.name} invited ${email} as ${inv.role}`, [{ type: 'invitation', id: inv.id, name: email }]);
      save();
      return json({ ...inv, organizationId: org.id });
    }
    case 'POST /organization/cancel-invitation': {
      const org = activeOrg(user);
      const inv = org?.invitations.find((i) => i.id === body.invitationId);
      if (!(org && inv)) return authError(404, 'INVITATION_NOT_FOUND', 'Invitation not found');
      inv.status = 'canceled';
      recordActivity(user, 'invitation.canceled', `${user.name} canceled the invitation for ${inv.email}`, [
        { type: 'invitation', id: inv.id, name: inv.email },
      ]);
      save();
      return json({ ...inv, organizationId: org.id });
    }
    case 'POST /organization/remove-member': {
      const org = activeOrg(user);
      const m = org?.members.find((x) => x.id === body.memberIdOrEmail);
      if (!(org && m)) return authError(404, 'MEMBER_NOT_FOUND', 'Member not found');
      if (m.role === 'owner') return authError(400, 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER', 'The owner cannot be removed');
      org.members = org.members.filter((x) => x.id !== m.id);
      const u = state.users.find((x) => x.id === m.userId);
      recordActivity(user, 'member.removed', `${user.name} removed ${u?.name ?? 'a member'} from ${org.name}`, [
        { type: 'user', id: m.userId, name: u?.name ?? '' },
      ]);
      save();
      return json({ member: m });
    }
    case 'POST /organization/update-member-role': {
      const org = activeOrg(user);
      const m = org?.members.find((x) => x.id === body.memberId);
      if (!(org && m)) return authError(404, 'MEMBER_NOT_FOUND', 'Member not found');
      const before = m.role;
      m.role = String(body.role ?? m.role);
      const u = state.users.find((x) => x.id === m.userId);
      recordActivity(
        user,
        'member.role.updated',
        `${user.name} changed ${u?.name ?? 'a member'}'s role from ${before} to ${m.role}`,
        [{ type: 'user', id: m.userId, name: u?.name ?? '' }],
        [{ field: 'role', before, after: m.role }],
      );
      save();
      return json(m);
    }
    default:
      return authError(404, 'NOT_FOUND', `Fixture auth endpoint ${method} ${path} is not implemented`);
  }
}

/* ------------------------------------------------------------------ */
/* Console API                                                         */
/* ------------------------------------------------------------------ */

function testEvent(project: StoredProject, user: FixtureUser): StoredEvent {
  const at = Date.now();
  const org = activeOrg(user);
  return normalize(
    {
      id: ulid(at, rng),
      action: 'trailmark.test_event',
      occurredAt: new Date(at).toISOString(),
      outcome: 'success',
      severity: 'info',
      description: `${user.name} sent a test event from the Trailmark console`,
      actor: { type: 'user', id: user.id, name: user.name, email: user.email },
      executor: { type: 'api', id: 'trailmark-console', name: 'Trailmark console' },
      tenant: org ? { id: org.id, name: org.name } : undefined,
      targets: [{ type: 'project', id: project.id, name: project.name }],
      context: { requestId: `req_${rng.alnum(10)}`, operationId: `op_${rng.alnum(10)}` },
      metadata: { source: 'console', note: 'Safe to ignore — sent to verify ingestion.' },
      schemaVersion: '1',
    },
    project.id,
    35,
  );
}

async function handleApi(url: URL, method: string, body: Record<string, unknown>): Promise<Response> {
  const user = currentUser();
  if (!user) return apiError(401, 'unauthorized', 'Sign in to continue.');
  const path = url.pathname;
  const org = activeOrg(user);

  if (path === '/api/me' && method === 'GET') {
    return json({
      user: { id: user.id, name: user.name, email: user.email, image: user.image },
      organizations: userOrgs(user).map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        role: o.members.find((m) => m.userId === user.id)?.role ?? 'member',
      })),
      activeOrganizationId: org?.id ?? null,
    });
  }

  if (path === '/api/workspace/activity' && method === 'GET') {
    if (!org) return apiError(400, 'no_active_organization', 'Create or select a workspace first.');
    const r = rangeOf(url);
    const events = activity()
      .range(r.from, r.to, url.searchParams.get('q') ?? undefined)
      .filter((e) => e.tenant?.id === org.id);
    return json(searchPage(events, url));
  }

  if (path === '/api/projects') {
    if (!org) return method === 'GET' ? json({ data: [] }) : apiError(400, 'no_active_organization', 'Create a workspace first.');
    if (method === 'GET') return json({ data: state.projects.filter((p) => p.organizationId === org.id).map(projectView) });
    if (method === 'POST') {
      const name = String(body.name ?? '').trim();
      if (name.length < 2) return apiError(400, 'validation_error', 'Project name must be at least 2 characters.');
      const retentionDays = Number(body.retentionDays ?? 90);
      if (!(RETENTION_OPTIONS as readonly number[]).includes(retentionDays)) return apiError(400, 'validation_error', 'Unsupported retention.');
      let slug = slugify(name);
      while (state.projects.some((p) => p.organizationId === org.id && p.slug === slug)) slug = `${slug}-${rng.int(2, 99)}`;
      const project: StoredProject = {
        id: nextId('prj'),
        organizationId: org.id,
        name,
        slug,
        description: typeof body.description === 'string' && body.description ? body.description : null,
        retentionDays,
        createdAt: new Date().toISOString(),
      };
      state.projects.push(project);
      const { secret, prefix } = newSecret('ingest');
      const key: ApiKey = {
        id: nextId('key'),
        projectId: project.id,
        name: 'Default ingest key',
        kind: 'ingest',
        prefix,
        createdAt: new Date().toISOString(),
        createdBy: { id: user.id, name: user.name },
        lastUsedAt: null,
        revokedAt: null,
      };
      state.keys.push(key);
      recordActivity(user, 'project.created', `${user.name} created the project ${name}`, [{ type: 'project', id: project.id, name }]);
      save();
      return json({ project: projectView(project), ingestKey: { key, secret } }, 201);
    }
  }

  const m = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!m) return apiError(404, 'not_found', `No fixture for ${method} ${path}`);
  const projectId = decodeURIComponent(m[1] ?? '');
  const rest = m[2] ?? '';
  const project = state.projects.find((p) => p.id === projectId && p.organizationId === org?.id);
  if (!project) return apiError(404, 'project_not_found', 'This project does not exist or you do not have access to it.');
  const store = storeFor(project.id);

  if (rest === '') {
    if (method === 'GET') return json(projectView(project));
    if (method === 'PATCH') {
      if (typeof body.retentionDays === 'number' && body.retentionDays !== project.retentionDays) {
        const lowering = body.retentionDays < project.retentionDays;
        if (lowering && body.confirm !== project.slug) {
          return apiError(
            400,
            'confirmation_required',
            `Type the project slug "${project.slug}" to confirm. Data older than ${body.retentionDays} days will be permanently deleted.`,
          );
        }
        const before = project.retentionDays;
        project.retentionDays = body.retentionDays;
        const cutoff = Date.now() - project.retentionDays * DAY;
        const started = new Date().toISOString();
        const deleted = store.purgeBefore(cutoff);
        state.retentionRuns[project.id] = {
          startedAt: started,
          finishedAt: new Date(Date.now() + 1200).toISOString(),
          status: 'succeeded',
          cutoff: new Date(cutoff).toISOString(),
          error: null,
        };
        recordActivity(
          user,
          'project.retention.changed',
          `${user.name} ${lowering ? 'lowered' : 'raised'} ${project.name} retention from ${before} to ${project.retentionDays} days${lowering ? ` (${deleted.toLocaleString('en-US')} events purged)` : ''}`,
          [{ type: 'project', id: project.id, name: project.name }],
          [{ field: 'retentionDays', before, after: project.retentionDays }],
        );
      }
      if (typeof body.name === 'string' && body.name.trim() && body.name !== project.name) {
        recordActivity(
          user,
          'project.updated',
          `${user.name} renamed ${project.name} to ${body.name}`,
          [{ type: 'project', id: project.id, name: body.name }],
          [{ field: 'name', before: project.name, after: body.name }],
        );
        project.name = body.name.trim();
      }
      if (body.description !== undefined && body.description !== project.description) {
        recordActivity(
          user,
          'project.updated',
          `${user.name} updated the description of ${project.name}`,
          [{ type: 'project', id: project.id, name: project.name }],
          [{ field: 'description', before: project.description ?? '', after: body.description ?? '' }],
        );
        project.description = (body.description as string | null) || null;
      }
      save();
      return json(projectView(project));
    }
    if (method === 'DELETE') {
      state.projects = state.projects.filter((p) => p.id !== project.id);
      stores.delete(project.id);
      recordActivity(user, 'project.deleted', `${user.name} deleted the project ${project.name} and all of its events`, [
        { type: 'project', id: project.id, name: project.name },
      ]);
      save();
      return json({ ok: true });
    }
  }

  if (rest === 'retention' && method === 'GET') {
    return json({ retentionDays: project.retentionDays, oldestEventAt: store.oldest(), lastRun: state.retentionRuns[project.id] ?? null });
  }

  if (rest === 'keys') {
    if (method === 'GET')
      return json({ data: state.keys.filter((k) => k.projectId === project.id).sort((a, b) => (a.revokedAt ? 1 : 0) - (b.revokedAt ? 1 : 0)) });
    if (method === 'POST') {
      const name = String(body.name ?? '').trim();
      const kind = body.kind === 'read' ? 'read' : 'ingest';
      if (!name) return apiError(400, 'validation_error', 'Give the key a name.');
      const { secret, prefix } = newSecret(kind);
      const key: ApiKey = {
        id: nextId('key'),
        projectId: project.id,
        name,
        kind,
        prefix,
        createdAt: new Date().toISOString(),
        createdBy: { id: user.id, name: user.name },
        lastUsedAt: null,
        revokedAt: null,
      };
      state.keys.unshift(key);
      recordActivity(user, 'api_key.created', `${user.name} created the ${kind} key “${name}” for ${project.name}`, [
        { type: 'api_key', id: key.id, name },
      ]);
      save();
      return json({ key, secret }, 201);
    }
  }
  const keyMatch = /^keys\/([^/]+)$/.exec(rest);
  if (keyMatch && method === 'DELETE') {
    const key = state.keys.find((k) => k.id === keyMatch[1] && k.projectId === project.id);
    if (!key) return apiError(404, 'key_not_found', 'Key not found.');
    key.revokedAt = new Date().toISOString();
    recordActivity(user, 'api_key.revoked', `${user.name} revoked the ${key.kind} key “${key.name}”`, [
      { type: 'api_key', id: key.id, name: key.name },
    ]);
    save();
    return json({ ok: true });
  }

  if (rest === 'events' && method === 'GET') {
    const r = rangeOf(url);
    return json(searchPage(store.range(r.from, r.to, url.searchParams.get('q') ?? undefined), url));
  }
  const eventMatch = /^events\/([^/]+)$/.exec(rest);
  if (eventMatch && method === 'GET') {
    const stored = store.get(decodeURIComponent(eventMatch[1] ?? ''));
    if (!stored) return apiError(404, 'event_not_found', 'No event with this id in the project (it may be past retention).');
    const parents: AuditEvent[] = [];
    let parentId = stored.event.context.parentEventId;
    while (parentId && parents.length < 20) {
      const p = store.get(parentId);
      if (!p) break;
      parents.unshift(p.event);
      parentId = p.event.context.parentEventId;
    }
    const all = store.all();
    const opId = stored.event.context.operationId;
    return json({
      event: stored.event,
      payload: stored.payload,
      parents,
      childCount: all.filter((e) => e.context.parentEventId === stored.event.id).length,
      operationSize: opId ? all.filter((e) => e.context.operationId === opId).length : 0,
    });
  }
  if (rest === 'live' && method === 'GET') {
    const since = url.searchParams.get('since') ?? new Date(Date.now() - 60_000).toISOString();
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const q = url.searchParams.get('q') ?? undefined;
    const now = new Date().toISOString();
    const data = store
      .range(new Date(Date.parse(since) - DAY).toISOString(), now, q)
      .filter((e) => e.receivedAt > since)
      .slice(0, limit);
    return json({ data, now });
  }
  if (rest === 'histogram' && method === 'GET') {
    const r = rangeOf(url);
    const interval = url.searchParams.get('interval') ? Number(url.searchParams.get('interval')) : undefined;
    return json(histogram(store.range(r.from, r.to, url.searchParams.get('q') ?? undefined), r.fromMs, r.toMs, interval));
  }
  if (rest === 'facets' && method === 'GET') {
    const r = rangeOf(url);
    const field = url.searchParams.get('field') ?? 'action';
    return json(facets(store.range(r.from, r.to, url.searchParams.get('q') ?? undefined), field, Number(url.searchParams.get('limit') ?? 10)));
  }
  const opMatch = /^operations\/([^/]+)$/.exec(rest);
  if (opMatch && method === 'GET') {
    const opId = decodeURIComponent(opMatch[1] ?? '');
    const events = store
      .all()
      .filter((e) => e.context.operationId === opId)
      .reverse();
    if (events.length === 0) return apiError(404, 'operation_not_found', 'No events carry this operation id (it may be past retention).');
    return json({ operationId: opId, events, truncated: false });
  }
  if (rest === 'export' && method === 'GET') {
    const r = rangeOf(url);
    const events = store.range(r.from, r.to, url.searchParams.get('q') ?? undefined).slice(0, 10_000);
    if (url.searchParams.get('format') === 'csv') {
      const head = 'id,timestamp,action,outcome,severity,actor_id,actor_name,tenant_id,executor_id,description';
      const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
      const rows = events.map((e) =>
        [
          e.id,
          e.timestamp,
          e.action,
          e.outcome,
          e.severity,
          e.actor?.id ?? '',
          e.actor?.name ?? '',
          e.tenant?.id ?? '',
          e.executor?.id ?? '',
          e.description,
        ]
          .map(esc)
          .join(','),
      );
      return new Response([head, ...rows].join('\n'), { headers: { 'content-type': 'text/csv' } });
    }
    return new Response(events.map((e) => JSON.stringify(e)).join('\n'), { headers: { 'content-type': 'application/x-ndjson' } });
  }
  if (rest === 'test-event' && method === 'POST') {
    const stored = testEvent(project, user);
    state.customEvents[project.id] = [...(state.customEvents[project.id] ?? []), stored];
    store.add([stored]);
    const key = state.keys.find((k) => k.projectId === project.id && k.kind === 'ingest' && !k.revokedAt);
    if (key) key.lastUsedAt = new Date().toISOString();
    save();
    return json({ accepted: 1, ids: [stored.event.id], rejected: [] }, 202);
  }
  if (rest === 'overview' && method === 'GET') {
    const r = rangeOf(url);
    return json(overview(store, r.fromMs, r.toMs, url.searchParams.get('q') ?? undefined));
  }
  if (rest === 'entities' && method === 'GET') {
    const kind = (url.searchParams.get('kind') ?? 'actor') as EntityKind;
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const type = url.searchParams.get('type') ?? '';
    const limit = Number(url.searchParams.get('limit') ?? 25);
    const offset = Number(url.searchParams.get('cursor') ?? 0) || 0;
    const list = [...entityIndex(store.all(), kind).values()]
      .filter((e) => (!type || e.type === type) && (!q || e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)))
      .sort((a, b) => b.events - a.events);
    return json({ data: list.slice(offset, offset + limit), nextCursor: offset + limit < list.length ? String(offset + limit) : null });
  }
  const entityMatch = /^entities\/(actor|tenant|executor|target)\/(.+)$/.exec(rest);
  if (entityMatch && method === 'GET') {
    const r = rangeOf(url);
    const result = profile(store, entityMatch[1] as EntityKind, decodeURIComponent(entityMatch[2] ?? ''), r.fromMs, r.toMs);
    return result ? json(result) : apiError(404, 'entity_not_found', 'No events mention this entity (it may be past retention).');
  }
  if (rest === 'fields' && method === 'GET') {
    const r = rangeOf(url);
    return json(fields(store.range(r.from, r.to)));
  }
  if (rest === 'views') {
    if (method === 'GET') return json({ data: state.views.filter((v) => v.projectId === project.id) });
    if (method === 'POST') {
      const name = String(body.name ?? '').trim();
      if (!name) return apiError(400, 'validation_error', 'Name the view.');
      const view: SavedView = {
        id: nextId('view'),
        projectId: project.id,
        name,
        description: (body.description as string | null) ?? null,
        state: (body.state as SavedView['state']) ?? {},
        createdBy: { id: user.id, name: user.name },
        createdAt: new Date().toISOString(),
      };
      state.views.push(view);
      recordActivity(user, 'view.created', `${user.name} saved the view “${name}”`, [{ type: 'saved_view', id: view.id, name }]);
      save();
      return json(view, 201);
    }
  }
  const viewMatch = /^views\/([^/]+)$/.exec(rest);
  if (viewMatch && method === 'DELETE') {
    const view = state.views.find((v) => v.id === viewMatch[1]);
    if (!view) return apiError(404, 'view_not_found', 'View not found.');
    state.views = state.views.filter((v) => v.id !== view.id);
    recordActivity(user, 'view.deleted', `${user.name} deleted the view “${view.name}”`, [{ type: 'saved_view', id: view.id, name: view.name }]);
    save();
    return json({ ok: true });
  }

  return apiError(404, 'not_found', `No fixture for ${method} ${path}`);
}

/** `fetch`-compatible entry point used by the transport in fixture mode. */
export async function fixtureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const url = new URL(req ? req.url : String(input), window.location.origin);
  const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
  let body: Record<string, unknown> = {};
  const rawBody = init?.body ?? (req && method !== 'GET' ? await req.clone().text() : undefined);
  if (typeof rawBody === 'string' && rawBody) {
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  const isLive = url.pathname.endsWith('/live');
  await sleep(isLive ? 30 : 90 + Math.random() * 180);
  if (url.pathname.startsWith('/api/auth/')) return handleAuth(url.pathname.slice('/api/auth'.length), method, body);
  if (url.pathname.startsWith('/api/')) return handleApi(url, method, body);
  return fetch(input, init);
}

if (typeof window !== 'undefined') {
  (window as unknown as { __trailmarkFixtures: unknown }).__trailmarkFixtures = { reset: resetFixtures, otp: FIXTURE_OTP };
}
