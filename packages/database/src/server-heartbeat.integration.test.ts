import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { prisma } from './index';
import { pruneServerHeartbeats, recordServerHeartbeat, SERVER_HEARTBEAT_CAPABILITY, startServerHeartbeat } from './server-heartbeat';

// The server heartbeat on real Postgres (fictional instance ids, removed afterwards). Nothing reads it in 0.3; #296's
// capability gate depends on every server having one.
const created: string[] = [];
const row = (instanceId: string) => prisma.serverHeartbeat.findUnique({ where: { instanceId } });
const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the heartbeat');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
/** Moves a row's last beat into the past, as if its server had stopped beating that long ago. */
const age = (instanceId: string, interval: string) =>
  prisma.$executeRaw`UPDATE "ServerHeartbeat" SET "seenAt" = (clock_timestamp() AT TIME ZONE 'UTC') - ${interval}::interval WHERE "instanceId" = ${instanceId}`;

afterAll(async () => {
  await prisma.serverHeartbeat.deleteMany({ where: { instanceId: { in: created } } });
  await prisma.$disconnect();
});

it('appears at start with its version and capabilities, refreshes every interval, and is removed on a clean stop', async () => {
  const heartbeat = startServerHeartbeat({ version: '0.0.0-qa', intervalMs: 300 });
  created.push(heartbeat.instanceId);
  try {
    const first = await waitFor(
      () => row(heartbeat.instanceId),
      (r) => r !== null,
    );
    expect(first).toMatchObject({ version: '0.0.0-qa', capabilities: [SERVER_HEARTBEAT_CAPABILITY] });
    // It does not declare what a later release's worker waits for: nothing depends on it in 0.3.
    expect(first?.capabilities).not.toContain('background-retention-v1');
    // Stamped by the database clock: within a few seconds of it.
    const [{ now }] = await prisma.$queryRaw<[{ now: Date }]>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    expect(Math.abs(now.getTime() - (first?.seenAt.getTime() ?? 0))).toBeLessThan(5000);
    const refreshed = await waitFor(
      () => row(heartbeat.instanceId),
      (r) => (r?.seenAt.getTime() ?? 0) > (first?.seenAt.getTime() ?? 0),
    );
    expect(refreshed?.seenAt.getTime()).toBeGreaterThan(first?.seenAt.getTime() ?? 0);
  } finally {
    await heartbeat.stop();
  }
  expect(await row(heartbeat.instanceId)).toBeNull();
  // No beat after stop puts it back.
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(await row(heartbeat.instanceId)).toBeNull();
});

it('a crashed server leaves its row, which ages out and is pruned by any server beat; fresh rows are kept', async () => {
  const crashed = `qa-heartbeat-crashed-${randomUUID()}`;
  const recent = `qa-heartbeat-recent-${randomUUID()}`;
  created.push(crashed, recent);
  // A server that beat and then died without stopping: its row stays.
  await recordServerHeartbeat(crashed, '0.0.0-qa', [SERVER_HEARTBEAT_CAPABILITY]);
  await recordServerHeartbeat(recent, '0.0.0-qa', [SERVER_HEARTBEAT_CAPABILITY]);
  expect(await row(crashed)).not.toBeNull();
  // Not yet a day old: kept.
  await age(crashed, '23 hours');
  await pruneServerHeartbeats();
  expect(await row(crashed)).not.toBeNull();
  // Older than a day: the next beat of any server prunes it, and only it.
  await age(crashed, '25 hours');
  const other = startServerHeartbeat({ version: '0.0.0-qa', intervalMs: 60_000 });
  created.push(other.instanceId);
  try {
    await waitFor(
      () => row(crashed),
      (r) => r === null,
    );
    expect(await row(recent)).not.toBeNull();
  } finally {
    await other.stop();
  }
});
