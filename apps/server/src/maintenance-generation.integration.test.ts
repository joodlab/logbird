import { prisma } from '@logbird/database';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';

let f: ImmutableFixture;
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
beforeEach(async () => {
  f = await immutableFixture();
  await f.authorize();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});
function latch() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
function request(path: string) {
  if (path.startsWith('suggest?')) return f.management(`/api/projects/${f.project}/${path}`);
  const join = path.includes('?') ? '&' : '?';
  return f.management(
    `/api/projects/${f.project}/${path}${join}from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date(Date.now() + 3_600_000).toISOString()}`,
  );
}
async function seed() {
  expect((await f.post({ id: 'retained', action: 'retained.event', actor: { id: 'person', type: 'user' }, metadata: { key: 'value' } })).status).toBe(
    202,
  );
  await f.pending({ id: 'abandoned', action: 'repair.pending' }, { expired: true });
}
it.each(['entities?kind=actor', 'entities/actor/person', 'overview', 'fields', 'suggest?field=actor'])(
  'discards an admitted %s response when repair deletes rollups before its query',
  async (path) => {
    await seed();
    const admitted = latch(),
      resumeRead = latch(),
      deleted = latch(),
      resumeRepair = latch();
    const query = clickhouse.query.bind(clickhouse),
      command = clickhouse.command.bind(clickhouse);
    let first = true;
    vi.spyOn(clickhouse, 'query').mockImplementation(async (params) => {
      if (first) {
        first = false;
        admitted.release();
        await resumeRead.promise;
      }
      return query(params);
    });
    vi.spyOn(clickhouse, 'command').mockImplementation(async (params) => {
      const result = await command(params);
      if (params.query.startsWith('DELETE FROM attribute_keys')) {
        deleted.release();
        await resumeRepair.promise;
      }
      return result;
    });
    const reading = request(path);
    let repairing: Promise<Response> | undefined;
    try {
      await admitted.promise;
      repairing = Promise.resolve(f.post({ id: 'abandoned', action: 'repair.pending' }));
      await deleted.promise;
      expect((await prisma.project.findUniqueOrThrow({ where: { id: f.project } })).maintenanceGeneration).toBe(1n);
      resumeRead.release();
      const response = await reading;
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('1');
      expect((await response.json()).error.code).toBe('retention_unavailable');
    } finally {
      resumeRead.release();
      resumeRepair.release();
      await reading;
      if (repairing) expect((await repairing).status).toBe(202);
    }
  },
);
it('detects a complete repair between checks even after its running fence disappears', async () => {
  await seed();
  const admitted = latch(),
    resume = latch();
  const query = clickhouse.query.bind(clickhouse);
  let first = true;
  vi.spyOn(clickhouse, 'query').mockImplementation(async (params) => {
    if (first) {
      first = false;
      admitted.release();
      await resume.promise;
    }
    return query(params);
  });
  const reading = request('entities/actor/person');
  try {
    await admitted.promise;
    expect((await f.post({ id: 'abandoned', action: 'repair.pending' })).status).toBe(202);
    expect(await prisma.retentionRun.count({ where: { projectId: f.project, status: 'running' } })).toBe(0);
    resume.release();
    const response = await reading;
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('retention_unavailable');
    vi.restoreAllMocks();
    expect((await request('entities/actor/person')).status).toBe(200);
  } finally {
    resume.release();
    await reading;
  }
});
