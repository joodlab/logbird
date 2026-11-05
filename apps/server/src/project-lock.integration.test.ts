import { randomUUID } from 'node:crypto';
import { ProjectBusyError, withProjectLock } from '@trailmark/database';
import { describe, expect, it } from 'vitest';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Real Postgres advisory locks on random fictional project ids; nothing else is touched.
describe('project locks (real Postgres)', () => {
  it('lets concurrent ingests on one project hold the shared lock together', async () => {
    const project = `lock-test-${randomUUID()}`;
    let inside = 0,
      peak = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        withProjectLock(
          project,
          async () => {
            peak = Math.max(peak, ++inside);
            await sleep(150);
            inside--;
          },
          { mode: 'shared' },
        ),
      ),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(peak).toBeGreaterThan(1);
  });

  it('makes maintenance wait for in-flight ingests, then excludes new ones', async () => {
    const project = `lock-test-${randomUUID()}`;
    const order: string[] = [];
    const ingest = withProjectLock(
      project,
      async () => {
        order.push('ingest:start');
        await sleep(300);
        order.push('ingest:end');
      },
      { mode: 'shared' },
    );
    await sleep(50);
    const maintenance = withProjectLock(project, async () => {
      order.push('maintenance:start');
      await sleep(400);
      order.push('maintenance:end');
    });
    await sleep(400); // maintenance now holds the data lock
    await expect(withProjectLock(project, async () => undefined, { mode: 'shared', waitMs: 100 })).rejects.toBeInstanceOf(ProjectBusyError);
    await Promise.all([ingest, maintenance]);
    expect(order).toEqual(['ingest:start', 'ingest:end', 'maintenance:start', 'maintenance:end']);
  });

  it('does not let a continuous stream of overlapping ingests starve maintenance', async () => {
    const project = `lock-test-${randomUUID()}`;
    let stop = false;
    const stream = (async () => {
      const inflight: Promise<unknown>[] = [];
      while (!stop) {
        inflight.push(withProjectLock(project, () => sleep(80), { mode: 'shared', waitMs: 2000 }).catch(() => undefined));
        await sleep(20); // a new ingest every 20 ms, each lasting 80 ms: there is never a gap
      }
      await Promise.all(inflight);
    })();
    await sleep(200);
    const started = Date.now();
    await withProjectLock(project, async () => undefined, { waitMs: 3000 });
    expect(Date.now() - started).toBeLessThan(2000);
    stop = true;
    await stream;
  });

  it('fails fast (no queueing) when maintenance is held', async () => {
    const project = `lock-test-${randomUUID()}`;
    let release!: () => void;
    const held = withProjectLock(
      project,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await sleep(100);
    const started = Date.now();
    await expect(withProjectLock(project, async () => undefined, { waitMs: 200 })).rejects.toBeInstanceOf(ProjectBusyError);
    expect(Date.now() - started).toBeLessThan(1500);
    release();
    await held;
  });
});
