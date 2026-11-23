import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type ClickHouseClient,
  createClickHouseClient,
  createMaintenanceClickHouseClient,
  insertEvents,
  normalizeEvent,
  purgeProject,
} from '@logbird/clickhouse';
import { closeProjectLocks, prisma } from '@logbird/database';
import { encryptWebhookSecret, webhookCursorClock } from '@logbird/database/webhooks';
import { generateWebhookSecret } from '@logbird/sdk';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { deliverWebhooks } from './webhook-delivery';

const ch = createClickHouseClient();
const runId = randomUUID();
const projects = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11', 'p12', 'p13', 'p14', 'p15', 'p16', 'p17', 'p18', 'p19'].map(
  (name) => `qa-webhook-claims-${name}-${runId}`,
);
const secretKey = Buffer.alloc(32, 9);
const received: { path: string; id: string }[] = [];
const receiver = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  received.push({ path: req.url ?? '', id: JSON.parse(body).id });
  res.writeHead(204).end();
});
let port = 0;
let eventsInserted = false;

beforeAll(async () => {
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  port = (receiver.address() as AddressInfo).port;
  for (const id of projects) {
    await prisma.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
    await prisma.project.create({ data: { id, organizationId: id, name: id, slug: id } });
  }
});

afterAll(async () => {
  receiver.closeAllConnections();
  await new Promise<void>((done) => receiver.close(() => done()));
  const maintenance = createMaintenanceClickHouseClient();
  try {
    if (eventsInserted) await purgeProject(maintenance, projects[0] ?? '');
  } finally {
    try {
      await prisma.organization.deleteMany({ where: { id: { in: projects } } });
    } finally {
      await Promise.all([ch.close(), maintenance.close(), prisma.$disconnect(), closeProjectLocks()]);
    }
  }
}, 360_000);

const endpoint = (projectId: string, name: string) =>
  prisma.webhookEndpoint.create({
    data: {
      projectId,
      url: `http://127.0.0.1:${port}/${name}`,
      secrets: { create: { ciphertext: encryptWebhookSecret(generateWebhookSecret(), secretKey) } },
    },
  });
const options = (totalTimeoutMs?: number) => ({
  secretKey,
  concurrency: 1,
  perEndpoint: 1,
  failureLimit: 50,
  transport: { allowHttp: true, allowAddress: (address: string) => address === '127.0.0.1', totalTimeoutMs },
});

it('moves a row whose event load outlasts the lease budget back in the queue so another endpoint is delivered', { timeout: 240_000 }, async () => {
  const [projectId = ''] = projects;
  const { now } = await webhookCursorClock(prisma);
  const receivedAt = new Date(+now - 60_000);
  const expiresAt = new Date(+now + 86_400_000);
  const slowEventId = `qa-slow-load-${runId}`;
  const healthyEventId = `qa-healthy-${runId}`;
  const rows = [slowEventId, healthyEventId].map((id) => {
    const event = normalizeEvent({ action: 'qa.webhook.claims', id }, { projectId, receivedAt });
    if (!event.ok) throw new Error(event.reason);
    return event.row;
  });
  eventsInserted = true;
  await insertEvents(ch, rows);
  const slowEndpoint = await endpoint(projectId, 'slow');
  const healthyEndpoint = await endpoint(projectId, 'healthy');
  const initialNext = new Date(+now - 120_000);
  const slow = await prisma.webhookDelivery.create({
    data: { endpointId: slowEndpoint.id, eventId: slowEventId, receivedAt, expiresAt, nextAttemptAt: initialNext },
  });
  const healthy = await prisma.webhookDelivery.create({
    data: { endpointId: healthyEndpoint.id, eventId: healthyEventId, receivedAt, expiresAt, nextAttemptAt: new Date(+now - 60_000) },
  });
  // Only the slow row's event read stalls. It ends early only when the worker aborts it.
  const stalled = new Proxy(ch, {
    get(target, property, proxy) {
      if (property !== 'query') return Reflect.get(target, property, proxy);
      return async (params: Parameters<ClickHouseClient['query']>[0]) => {
        if ((params.query_params as Record<string, unknown> | undefined)?.id === slowEventId)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 40_000);
            params.abort_signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new Error('QA slow event load aborted'));
              },
              { once: true },
            );
          });
        return target.query(params);
      };
    },
  });
  // A 31-second transport timeout leaves about 1.5 seconds of the two-minute lease for the event load
  // (lease − 56.5 s settlement reserve − two transport timeouts), so the test needs no long wait.
  let passes = 0;
  while (!received.some(({ id }) => id === healthyEventId) && passes < 3) {
    passes++;
    await deliverWebhooks(stalled, options(31_000), projectId);
  }
  expect(received.filter(({ id }) => id === healthyEventId)).toHaveLength(1);
  expect(passes).toBeLessThanOrEqual(2);
  expect(received.some(({ id }) => id === slowEventId)).toBe(false);
  const after = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: slow.id }, include: { attempts: true } });
  expect(after).toMatchObject({ status: 'pending', attemptNumber: 1, leaseUntil: null });
  expect(after.attempts).toMatchObject([{ number: 1, status: 'failed', error: 'lookup_failed' }]);
  const { now: settledAt } = await webhookCursorClock(prisma);
  expect(+(after.nextAttemptAt ?? 0)).toBeGreaterThan(+settledAt);
  expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: healthy.id } })).toMatchObject({ status: 'succeeded', attemptNumber: 1 });
  // A lookup failure is internal: the slow endpoint is not charged toward auto-disable.
  expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: slowEndpoint.id } })).toMatchObject({
    enabled: true,
    consecutiveFailures: 0,
    failingSince: null,
  });
});

it('claims and delivers another project once while the first project claim keeps failing', { timeout: 60_000 }, async () => {
  const [first = '', second = ''] = projects;
  const { now } = await webhookCursorClock(prisma);
  const expiresAt = new Date(+now + 86_400_000);
  const failing = await prisma.webhookDelivery.create({
    data: { endpointId: (await endpoint(first, 'p1')).id, eventId: `qa-p1-${runId}`, expiresAt, nextAttemptAt: new Date(+now - 120_000) },
  });
  const other = await prisma.webhookDelivery.create({
    data: { endpointId: (await endpoint(second, 'p2')).id, eventId: `qa-p2-${runId}`, expiresAt, nextAttemptAt: new Date(+now - 60_000) },
  });
  // Force an error on the first project's row only, in the claim's own write.
  const suffix = randomBytes(4).toString('hex');
  const fn = `qa_fail_claim_${suffix}`;
  const trigger = `qa_fail_claim_${suffix}`;
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA claim failure for project one'; END $$`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${trigger} BEFORE UPDATE ON "WebhookDelivery" FOR EACH ROW WHEN (OLD.id = '${failing.id}') EXECUTE FUNCTION ${fn}()`,
  );
  const sent = (id: string) => received.filter((message) => message.id === id).length;
  try {
    await deliverWebhooks(ch, { ...options(), concurrency: 4 }, [first, second]);
    expect(sent(other.eventId)).toBe(1);
    expect(sent(failing.eventId)).toBe(0);
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: failing.id } })).toMatchObject({
      status: 'pending',
      attemptNumber: 0,
      leaseUntil: null,
    });
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON "WebhookDelivery"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
  // Once the first project's claim can commit, it is delivered, and the second project's row is not sent again.
  await deliverWebhooks(ch, { ...options(), concurrency: 4 }, [first, second]);
  expect(sent(failing.eventId)).toBe(1);
  expect(sent(other.eventId)).toBe(1);
  expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ status: 'succeeded', attemptNumber: 1 });
});

const ping = async (endpointId: string, name: string, nextAttemptAt: Date) =>
  prisma.webhookDelivery.create({
    data: { endpointId, eventId: `qa-${name}-${runId}`, expiresAt: new Date(+nextAttemptAt + 86_400_000), nextAttemptAt },
  });

it('delivers another project within bounded passes while the oldest row stays locked by another transaction', { timeout: 60_000 }, async () => {
  const [, , first = '', second = ''] = projects;
  const { now } = await webhookCursorClock(prisma);
  const locked = await ping((await endpoint(first, 'locked')).id, 'locked', new Date(+now - 120_000));
  const other = await ping((await endpoint(second, 'unlocked')).id, 'unlocked', new Date(+now - 60_000));
  // Another worker or a long transaction keeps the oldest due row locked across every pass.
  let release: () => void = () => undefined;
  const released = new Promise<void>((done) => {
    release = done;
  });
  let ready: () => void = () => undefined;
  const holding = new Promise<void>((done) => {
    ready = done;
  });
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "WebhookDelivery" WHERE id = ${locked.id} FOR UPDATE`;
      ready();
      await released;
    },
    { timeout: 50_000, maxWait: 5000 },
  );
  const sent = (id: string) => received.filter((message) => message.id === id).length;
  let passes = 0;
  try {
    await holding;
    while (!sent(other.eventId) && passes < 3) {
      passes++;
      await deliverWebhooks(ch, options(), [first, second]);
    }
    expect(sent(other.eventId)).toBe(1);
    expect(passes).toBe(1);
    expect(sent(locked.eventId)).toBe(0);
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: locked.id } })).toMatchObject({ status: 'pending', attemptNumber: 0 });
  } finally {
    release();
    await holder;
  }
  await deliverWebhooks(ch, options(), [first, second]);
  expect(sent(locked.eventId)).toBe(1);
  expect(sent(other.eventId)).toBe(1);
});

it("delivers another project's due row in the first pass while one project has more due rows than the slots", { timeout: 60_000 }, async () => {
  const [, , first = '', second = ''] = projects;
  const { now } = await webhookCursorClock(prisma);
  const busy = await endpoint(first, 'backlog');
  // Eight older rows in one project against two slots: oldest-first selection would fill both slots for four passes.
  const backlog = await Promise.all(Array.from({ length: 8 }, (_, index) => ping(busy.id, `backlog-${index}`, new Date(+now - 300_000 + index))));
  const other = await ping((await endpoint(second, 'single')).id, 'single', new Date(+now - 60_000));
  const sent = (id: string) => received.filter((message) => message.id === id).length;
  let passes = 0;
  while (!sent(other.eventId) && passes < 3) {
    passes++;
    await deliverWebhooks(ch, { ...options(), concurrency: 2, perEndpoint: 4 }, [first, second]);
  }
  expect(sent(other.eventId)).toBe(1);
  expect(passes).toBe(1);
  // The busy project still took the other slot, and no row was claimed twice.
  expect(backlog.filter(({ eventId }) => sent(eventId) === 1)).toHaveLength(1);
  expect(received.filter(({ id }) => backlog.some(({ eventId }) => eventId === id)).length).toBe(1);
});

// Hold rows locked from an open transaction, as another worker or a long transaction would, until released.
async function holdLocked(ids: string[]) {
  let release: () => void = () => undefined;
  const released = new Promise<void>((done) => {
    release = done;
  });
  let ready: () => void = () => undefined;
  const holding = new Promise<void>((done) => {
    ready = done;
  });
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "WebhookDelivery" WHERE id = ANY(${ids}::text[]) FOR UPDATE`;
      ready();
      await released;
    },
    { timeout: 50_000, maxWait: 5000 },
  );
  await holding;
  return async () => {
    release();
    await holder;
  };
}

it("delivers another project within bounded passes while all of one project's older rows stay locked", { timeout: 60_000 }, async () => {
  const [, , , , first = '', second = ''] = projects;
  const { now } = await webhookCursorClock(prisma);
  const busy = await endpoint(first, 'all-locked');
  // Four older rows, one more than enough to use every refill round of a one-slot pass on a skipped row.
  const lockedRows = await Promise.all(
    Array.from({ length: 4 }, (_, index) => ping(busy.id, `all-locked-${index}`, new Date(+now - 300_000 + index))),
  );
  const other = await ping((await endpoint(second, 'past-locked')).id, 'past-locked', new Date(+now - 60_000));
  const sent = (id: string) => received.filter((message) => message.id === id).length;
  const unlock = await holdLocked(lockedRows.map(({ id }) => id));
  let passes = 0;
  try {
    while (!sent(other.eventId) && passes < 3) {
      passes++;
      await deliverWebhooks(ch, options(), [first, second]);
    }
    expect(sent(other.eventId)).toBe(1);
    expect(passes).toBe(1);
  } finally {
    await unlock();
  }
  for (const row of lockedRows) {
    expect(sent(row.eventId)).toBe(0);
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'pending',
      attemptNumber: 0,
      leaseUntil: null,
    });
  }
});

it('dispatches the claims already committed when a later claim fails', { timeout: 60_000 }, async () => {
  const [, , , , , , first = '', second = ''] = projects;
  const { now } = await webhookCursorClock(prisma);
  const claimable = await ping((await endpoint(first, 'refill-claimable')).id, 'refill-claimable', new Date(+now - 120_000));
  const locked = await ping((await endpoint(second, 'refill-locked')).id, 'refill-locked', new Date(+now - 60_000));
  const sent = (id: string) => received.filter((message) => message.id === id).length;
  const unlock = await holdLocked([locked.id]);
  // The first claim takes the first project's row (the second project's row is locked). The next claim fails before it
  // can pick a row. Each claim is its own transaction, and the pass starts no other transaction before dispatch.
  const transaction = prisma.$transaction.bind(prisma);
  let selections = 0;
  const injected = vi.spyOn(prisma, '$transaction').mockImplementation((async (...args: unknown[]) => {
    if (++selections === 2) throw new Error('QA refill selection failure');
    return Reflect.apply(transaction, prisma, args);
  }) as typeof prisma.$transaction);
  const errors = vi.spyOn(console, 'error');
  try {
    await expect(deliverWebhooks(ch, { ...options(), concurrency: 2 }, [first, second])).resolves.toBeUndefined();
    expect(selections).toBeGreaterThanOrEqual(2);
    expect(errors.mock.calls.map(([message]) => String(message))).toContainEqual(expect.stringContaining('webhook.claim_failed'));
  } finally {
    injected.mockRestore();
    errors.mockRestore();
    await unlock();
  }
  // The committed claim was dispatched in the same pass instead of waiting out its lease.
  expect(sent(claimable.eventId)).toBe(1);
  expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: claimable.id } })).toMatchObject({ status: 'succeeded', attemptNumber: 1 });
  expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: locked.id } })).toMatchObject({ status: 'pending', attemptNumber: 0 });
});

it("claims a project's next endpoint while its oldest due row stays locked", { timeout: 60_000 }, async () => {
  const [, , , , , , , , project = ''] = projects;
  const { now } = await webhookCursorClock(prisma);
  const oldest = await ping((await endpoint(project, 'sibling-locked')).id, 'sibling-locked', new Date(+now - 120_000));
  const sibling = await ping((await endpoint(project, 'sibling-free')).id, 'sibling-free', new Date(+now - 60_000));
  const sent = (id: string) => received.filter((message) => message.id === id).length;
  const unlock = await holdLocked([oldest.id]);
  let passes = 0;
  try {
    while (!sent(sibling.eventId) && passes < 3) {
      passes++;
      await deliverWebhooks(ch, options(), project);
    }
    expect(sent(sibling.eventId)).toBe(1);
    expect(passes).toBe(1);
    expect(sent(oldest.eventId)).toBe(0);
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: oldest.id } })).toMatchObject({
      status: 'pending',
      attemptNumber: 0,
      leaseUntil: null,
    });
  } finally {
    await unlock();
  }
});

it('serves another project before the newer work of a project whose oldest row stays locked', { timeout: 60_000 }, async () => {
  const [, , , , , , , , , busy = '', waiting = ''] = projects;
  const { now } = await webhookCursorClock(prisma);
  const busyLocked = await endpoint(busy, 'newer-locked');
  const busyFree = await endpoint(busy, 'newer-free');
  const oldest = await ping(busyLocked.id, 'newer-oldest', new Date(+now - 120_000));
  const other = await ping((await endpoint(waiting, 'newer-waiting')).id, 'newer-waiting', new Date(+now - 60_000));
  const sent = (id: string) => received.filter((message) => message.id === id).length;
  const unlock = await holdLocked([oldest.id]);
  let passes = 0;
  try {
    // Two projects with claimable work and one slot: the bound is ceil(2 / 1) = 2 passes. The busy project gets newer
    // work before every pass.
    while (!sent(other.eventId) && passes < 2) {
      const clock = await webhookCursorClock(prisma);
      await ping(busyFree.id, `newer-work-${passes}`, clock.now);
      passes++;
      await deliverWebhooks(ch, options(), [busy, waiting]);
    }
    expect(sent(other.eventId)).toBe(1);
    expect(sent(oldest.eventId)).toBe(0);
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: oldest.id } })).toMatchObject({ status: 'pending', attemptNumber: 0 });
  } finally {
    await unlock();
  }
});

// Deterministic generator for the randomized layouts (mulberry32).
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// Replay one layout: WEBHOOK_FAIRNESS_SEEDS=1017 pnpm vitest run src/webhook-claims.integration.test.ts -t "seeded layouts"
// (comma-separate several seeds). A failure names its seed.
const FAIRNESS_SEEDS = process.env.WEBHOOK_FAIRNESS_SEEDS?.split(',').map(Number) ?? Array.from({ length: 32 }, (_, index) => 1000 + index);

// Hold endpoint rows locked from an open transaction, as an endpoint edit would, until released.
async function holdLockedEndpoints(ids: string[]) {
  let release: () => void = () => undefined;
  const released = new Promise<void>((done) => {
    release = done;
  });
  let ready: () => void = () => undefined;
  const holding = new Promise<void>((done) => {
    ready = done;
  });
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "WebhookEndpoint" WHERE id = ANY(${ids}::text[]) FOR UPDATE`;
      ready();
      await released;
    },
    { timeout: 120_000, maxWait: 5000 },
  );
  await holding;
  return async () => {
    release();
    await holder;
  };
}

it('claims every project within ceil(P / N) passes and each delivery within r * ceil(P / N) passes across seeded layouts', {
  timeout: 900_000,
}, async () => {
  // The r * ceil(P / N) bound is asserted for each project's first RANKS claimable rows, which keeps the pass count bounded.
  const RANKS = 4;
  for (const seed of FAIRNESS_SEEDS) {
    const random = seeded(seed);
    const pick = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
    const ids = Array.from({ length: pick(2, 4) }, (_, index) => `qa-webhook-fair-${runId}-${seed}-${index}`);
    const slots = pick(1, 3);
    const perEndpoint = pick(1, 2);
    let unlockRows: () => Promise<void> = async () => undefined;
    let unlockEndpoint: () => Promise<void> = async () => undefined;
    try {
      for (const id of ids) {
        await prisma.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
        await prisma.project.create({ data: { id, organizationId: id, name: id, slug: id } });
      }
      const { now } = await webhookCursorClock(prisma);
      type Row = { id: string; eventId: string; project: string; endpointId: string; due: Date };
      const rows: Row[] = [];
      const endpoints: { id: string; project: string }[] = [];
      for (const project of ids)
        for (let e = pick(1, 3); e > 0; e--) {
          const hook = await endpoint(project, `fair-${seed}-${endpoints.length}`);
          endpoints.push({ id: hook.id, project });
        }
      // One endpoint with an invalid stored scope (a legacy tenant with surrounding whitespace), not yet flagged.
      const invalid = endpoints[pick(0, endpoints.length - 1)];
      if (!invalid) throw new Error('No endpoint');
      await prisma.webhookEndpoint.update({ where: { id: invalid.id }, data: { scopeTenantId: ' qa-invalid ' } });
      const valid = endpoints.filter(({ id }) => id !== invalid.id);
      // Deep locked prefix: more locked rows on one endpoint than a claim scans in one go, then one unlocked row.
      const deep = random() < 0.6 ? valid[pick(0, valid.length - 1)] : undefined;
      // Allowance pressure: a deep unlocked backlog on one endpoint.
      const backlog = random() < 0.5 ? valid[pick(0, valid.length - 1)] : undefined;
      const locked: Row[] = [];
      const addRow = async (hook: { id: string; project: string }, due: Date) => {
        const row = await ping(hook.id, `fair-${seed}-${rows.length}`, due);
        const entry = { id: row.id, eventId: row.eventId, project: hook.project, endpointId: hook.id, due };
        rows.push(entry);
        return entry;
      };
      for (const hook of endpoints) {
        if (hook === deep) {
          const count = pick(33, 36);
          for (let r = 0; r < count; r++) {
            const entry = await addRow(hook, new Date(+now - 600_000 + r));
            if (r < count - 1) locked.push(entry);
          }
          continue;
        }
        const count = hook === backlog ? pick(8, 12) : pick(1, 3);
        for (let r = 0; r < count; r++) {
          const entry = await addRow(hook, new Date(+now - 600_000 + pick(0, 500_000)));
          if (hook !== backlog && random() < 0.3) locked.push(entry);
        }
      }
      if (locked.length) unlockRows = await holdLocked(locked.map(({ id }) => id));
      // The invalid-scope endpoint's own row is held locked in some layouts.
      const invalidLocked = random() < 0.5;
      if (invalidLocked) unlockEndpoint = await holdLockedEndpoints([invalid.id]);
      const claimable = rows
        .filter((row) => row.endpointId !== invalid.id && !locked.includes(row))
        .sort((a, b) => +a.due - +b.due || a.id.localeCompare(b.id));
      // The first project keeps getting newer work between passes, on an endpoint that can take it.
      const busy = valid.find(({ project, id }) => project === ids[0] && id !== deep?.id);
      const competing = new Set([...claimable.map(({ project }) => project), ...(busy ? [busy.project] : [])]);
      const bound = Math.ceil(competing.size / slots);
      const rank = new Map<string, number>();
      for (const project of competing)
        for (const [index, row] of claimable.filter((candidate) => candidate.project === project).entries()) rank.set(row.id, index + 1);
      const maxPasses = RANKS * bound;
      const sentAt = new Map<string, number>();
      const sentCount = (eventId: string) => received.filter(({ id }) => id === eventId).length;
      const record = (pass: number) => {
        for (const row of rows) if (!sentAt.has(row.id) && sentCount(row.eventId)) sentAt.set(row.id, pass);
      };
      const pass = async () => deliverWebhooks(ch, { ...options(), concurrency: slots, perEndpoint }, ids);
      for (let n = 1; n <= maxPasses; n++) {
        if (busy) await ping(busy.id, `fair-${seed}-newer-${n}`, (await webhookCursorClock(prisma)).now);
        const started = performance.now();
        await pass();
        // No pass waits on a locked row or endpoint.
        expect(performance.now() - started, `seed ${seed}: pass ${n} duration`).toBeLessThan(5000);
        record(n);
      }
      const layout = `P=${competing.size} N=${slots} A=${perEndpoint} bound=${bound} rows=${rows.length} locked=${locked.length} deep=${!!deep} backlog=${!!backlog} invalidLocked=${invalidLocked}`;
      for (const row of claimable) {
        const r = rank.get(row.id) ?? 1;
        if (r > RANKS) continue;
        expect(sentAt.get(row.id), `${layout}: ${row.eventId} (rank ${r}) within ${r * bound} passes`).toBeLessThanOrEqual(r * bound);
      }
      for (const project of new Set(claimable.map(({ project }) => project))) {
        const first = Math.min(...rows.filter((row) => row.project === project).map((row) => sentAt.get(row.id) ?? Number.POSITIVE_INFINITY));
        expect(first, `${layout}: project ${project} served within ${bound} passes`).toBeLessThanOrEqual(bound);
      }
      for (const row of locked) {
        expect(sentCount(row.eventId), `${layout}: locked ${row.eventId} not sent`).toBe(0);
        expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ attemptNumber: 0 });
      }
      for (const row of rows) expect(sentCount(row.eventId), `${layout}: ${row.eventId} sent at most once`).toBeLessThanOrEqual(1);
      const invalidRows = rows.filter((row) => row.endpointId === invalid.id);
      for (const row of invalidRows) expect(sentCount(row.eventId)).toBe(0);
      expect(await prisma.webhookAttempt.count({ where: { delivery: { endpointId: invalid.id } } }), `${layout}: slots spent on invalid scope`).toBe(
        0,
      );
      // Once nothing holds the endpoint row, a pass records the scope hold.
      await unlockEndpoint();
      unlockEndpoint = async () => undefined;
      await pass();
      if (invalidRows.length)
        expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: invalid.id } }), `${layout}: invalid scope held`).toMatchObject({
          scopeReviewRequired: true,
        });
    } catch (error) {
      throw new Error(`Fairness seed ${seed} failed (replay: WEBHOOK_FAIRNESS_SEEDS=${seed}): ${error instanceof Error ? error.message : error}`);
    } finally {
      await unlockEndpoint();
      await unlockRows();
      await prisma.organization.deleteMany({ where: { id: { in: ids } } });
    }
  }
});

it('claims a project that was never claimed before projects that were, even when their rows are older', { timeout: 60_000 }, async () => {
  const [, , , , , , , , , , , served = '', fresh = ''] = projects;
  const { now } = await webhookCursorClock(prisma);
  // After the upgrade every project lacks a rotation row, which ranks it first. A served project has one.
  await prisma.webhookClaimRotation.create({ data: { projectId: served, lastClaimedAt: new Date(+now - 3_600_000) } });
  const older = await ping((await endpoint(served, 'rotation-served')).id, 'rotation-served', new Date(+now - 300_000));
  const newer = await ping((await endpoint(fresh, 'rotation-fresh')).id, 'rotation-fresh', new Date(+now - 1000));
  const sent = (id: string) => received.filter((message) => message.id === id).length;
  await deliverWebhooks(ch, options(), [served, fresh]);
  expect(sent(newer.eventId)).toBe(1);
  expect(sent(older.eventId)).toBe(0);
  expect(await prisma.webhookClaimRotation.findUniqueOrThrow({ where: { projectId: fresh } })).toMatchObject({ lastClaimedAt: expect.any(Date) });
  // Now both have been claimed; the one claimed longer ago goes first.
  await deliverWebhooks(ch, options(), [served, fresh]);
  expect(sent(older.eventId)).toBe(1);
});

it('rolls the fair-phase statement back as a whole when it fails, and claims normally on the next pass', { timeout: 60_000 }, async () => {
  const [, , , , , , , , , , , , , first = '', second = ''] = projects;
  const { now } = await webhookCursorClock(prisma);
  const failing = await ping((await endpoint(first, 'rollback-first')).id, 'rollback-first', new Date(+now - 120_000));
  const other = await ping((await endpoint(second, 'rollback-second')).id, 'rollback-second', new Date(+now - 60_000));
  const sent = (id: string) => received.filter((message) => message.id === id).length;
  const attempts = (deliveryId: string) => prisma.webhookAttempt.count({ where: { deliveryId } });
  const rotation = (projectId: string) => prisma.webhookClaimRotation.findUnique({ where: { projectId } });
  const suffix = randomBytes(4).toString('hex');
  const fn = `qa_fail_fair_${suffix}`;
  // A forced error inside the statement, on chosen rows only.
  const failOn = async (ids: string[]) => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON "WebhookDelivery"`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE UPDATE ON "WebhookDelivery" FOR EACH ROW WHEN (OLD.id IN (${ids.map((id) => `'${id}'`).join(', ')})) EXECUTE FUNCTION ${fn}()`,
    );
  };
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA fair statement failure'; END $$`,
  );
  const errors = vi.spyOn(console, 'error');
  try {
    // Every row of the pass fails: the fair statement and the per-project retry claim nothing at all.
    await failOn([failing.id, other.id]);
    await deliverWebhooks(ch, { ...options(), concurrency: 2 }, [first, second]);
    for (const row of [failing, other]) {
      expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
        status: 'pending',
        attemptNumber: 0,
        leaseUntil: null,
      });
      expect(await attempts(row.id)).toBe(0);
      expect(sent(row.eventId)).toBe(0);
    }
    expect(await rotation(first)).toBeNull();
    expect(await rotation(second)).toBeNull();
    expect(errors.mock.calls.map(([message]) => String(message))).toContainEqual(expect.stringContaining('webhook.claim_fair_failed'));
    // Only the first project's row fails. The fair statement claimed the second project's row too, and that write rolled
    // back with it: the per-project retry claims the second row exactly once.
    await failOn([failing.id]);
    await deliverWebhooks(ch, { ...options(), concurrency: 2 }, [first, second]);
    expect(sent(other.eventId)).toBe(1);
    expect(await attempts(other.id)).toBe(1);
    expect(await rotation(second)).not.toBeNull();
    expect(await rotation(first)).toBeNull();
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: failing.id } })).toMatchObject({ attemptNumber: 0, leaseUntil: null });
  } finally {
    errors.mockRestore();
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON "WebhookDelivery"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
  // The next pass claims normally.
  await deliverWebhooks(ch, { ...options(), concurrency: 2 }, [first, second]);
  expect(sent(failing.eventId)).toBe(1);
  expect(await rotation(first)).not.toBeNull();
});

it("removes a project's claim rotation row when the project is deleted", async () => {
  const id = `qa-webhook-claims-rotation-${runId}`;
  await prisma.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
  await prisma.project.create({ data: { id, organizationId: id, name: id, slug: id } });
  await prisma.webhookClaimRotation.create({ data: { projectId: id, lastClaimedAt: new Date() } });
  await prisma.project.delete({ where: { id } });
  expect(await prisma.webhookClaimRotation.findUnique({ where: { projectId: id } })).toBeNull();
  await prisma.organization.deleteMany({ where: { id } });
});

it('claims the first unlocked row behind more locked rows than a claim scans at once, on the first pass', { timeout: 60_000 }, async () => {
  const [, , , , , , , , , , , , , , , deepProject = '', other = ''] = projects;
  const { now } = await webhookCursorClock(prisma);
  const deepHook = await endpoint(deepProject, 'deep-prefix');
  const prefix: { id: string; eventId: string }[] = [];
  for (let index = 0; index < 32; index++) prefix.push(await ping(deepHook.id, `deep-prefix-${index}`, new Date(+now - 300_000 + index)));
  const thirtyThird = await ping(deepHook.id, 'deep-prefix-33rd', new Date(+now - 300_000 + 32));
  const otherHook = await endpoint(other, 'deep-other');
  await ping(otherHook.id, 'deep-other-0', new Date(+now - 60_000));
  const sent = (id: string) => received.filter((message) => message.id === id).length;
  const unlock = await holdLocked(prefix.map(({ id }) => id));
  try {
    // The other project also keeps receiving newer work.
    await ping(otherHook.id, 'deep-other-newer', (await webhookCursorClock(prisma)).now);
    await deliverWebhooks(ch, { ...options(), concurrency: 2 }, [deepProject, other]);
    expect(sent(thirtyThird.eventId)).toBe(1);
    for (const row of prefix) expect(sent(row.eventId)).toBe(0);
  } finally {
    await unlock();
  }
});

it('fills every slot from endpoints with room when two endpoints have deep older backlogs', { timeout: 60_000 }, async () => {
  const [, , , , , , , , , , , , , , , , , project = ''] = projects;
  const { now } = await webhookCursorClock(prisma);
  const hooks = await Promise.all(['fill-a', 'fill-b', 'fill-c', 'fill-d'].map((name) => endpoint(project, name)));
  const [a, b, c, d] = hooks;
  if (!a || !b || !c || !d) throw new Error('Missing endpoint');
  const mine: string[] = [];
  for (let index = 0; index < 20; index++)
    for (const hook of [a, b]) mine.push((await ping(hook.id, `fill-${hook.id}-${index}`, new Date(+now - 600_000 + index))).eventId);
  for (let index = 0; index < 3; index++)
    for (const hook of [c, d]) mine.push((await ping(hook.id, `fill-${hook.id}-${index}`, new Date(+now - 60_000 + index))).eventId);
  // Eight slots and two leases per endpoint: every endpoint has room for two, so one pass fills all eight.
  await deliverWebhooks(ch, { ...options(), concurrency: 8, perEndpoint: 2 }, project);
  expect(received.filter(({ id }) => mine.includes(id))).toHaveLength(8);
  for (const hook of hooks)
    expect(received.filter(({ path, id }) => path.endsWith(hook.url.split('/').pop() ?? '') && mine.includes(id))).toHaveLength(2);
});

it("claims a project's healthy endpoint on the first pass when its sibling endpoint's scan times out", { timeout: 60_000 }, async () => {
  const project = projects[18] ?? '';
  const { now } = await webhookCursorClock(prisma);
  const slow = await endpoint(project, 'timeout-slow');
  const healthy = await endpoint(project, 'timeout-healthy');
  const lockedRows = await Promise.all(
    Array.from({ length: 3 }, (_, index) => ping(slow.id, `timeout-slow-${index}`, new Date(+now - 300_000 + index))),
  );
  const healthyRow = await ping(healthy.id, 'timeout-healthy', new Date(+now - 60_000));
  const sent = (id: string) => received.filter((message) => message.id === id).length;
  const unlock = await holdLocked(lockedRows.map(({ id }) => id));
  const errors = vi.spyOn(console, 'error');
  try {
    // Test hook: a 300 ms claim statement timeout, and a 1 s sleep in the slow endpoint's scan, so every statement that
    // scans that endpoint times out deterministically.
    await deliverWebhooks(ch, { ...options(), claimTimeoutMs: 300, claimScanDelay: { endpointId: slow.id, seconds: 1 } }, project);
    expect(sent(healthyRow.eventId)).toBe(1);
    const endpointFailures = errors.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('webhook.claim_endpoint_failed'));
    expect(endpointFailures.some((message) => message.includes(slow.id))).toBe(true);
  } finally {
    errors.mockRestore();
    await unlock();
  }
  for (const row of lockedRows) {
    expect(sent(row.eventId)).toBe(0);
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'pending', attemptNumber: 0 });
  }
});
