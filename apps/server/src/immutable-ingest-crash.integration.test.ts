import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { read } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';

let f: ImmutableFixture,
  clock = Date.now();
vi.setConfig({ hookTimeout: 30_000 });
beforeEach(async () => {
  f = await immutableFixture();
});
afterEach(async () => {
  clock = Date.now();
  vi.useRealTimers();
  await f.cleanup();
});
it.each(['before-send', 'after-ack'] as const)(
  'recovers actual process death %s with independent client pools and no double count',
  async (phase) => {
    const input = { id: 'crash-original', action: 'crash.original', actor: { id: 'crash-actor', type: 'user' } };
    const child = fork(fileURLToPath(new URL('./ingest-crash-fixture.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'],
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += String(data);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stage = new Promise<{ stage: string }>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Crash fixture IPC timeout')), 20_000);
        child.once('message', (message) => resolve(message as { stage: string }));
        child.once('exit', () => reject(new Error(`Crash fixture exited early: ${stderr.slice(-200)}`)));
      });
      child.send({ projectId: f.project, input, phase });
      expect((await stage).stage).toBe(phase === 'before-send' ? 'claimed' : 'acknowledged');
      if (timer) clearTimeout(timer);
      const pending = await prisma.ingestReceipt.findUniqueOrThrow({ where: { projectId_eventId: { projectId: f.project, eventId: input.id } } });
      expect(pending.confirmedAt).toBeNull();
      const mixed = await f.post([input, { id: 'healthy', action: 'healthy.sibling' }]);
      expect(mixed.status).toBe(503);
      expect((await mixed.json()).error.details).toMatchObject({ accepted: 1, ids: ['healthy'], indices: [0] });
      expect(await f.count()).toBe(phase === 'before-send' ? 1 : 2);
      child.kill('SIGKILL');
      await exited;
      vi.useFakeTimers({ toFake: ['Date'] });
      clock = Math.max(clock, Date.now()) + 61_000;
      vi.setSystemTime(clock);
      await prisma.ingestReceipt.updateMany({
        where: { projectId: f.project, eventId: input.id },
        data: { claimedAt: new Date(Date.now() - 80_000) },
      });
      expect((await f.post(input)).status).toBe(202);
      expect(await f.count()).toBe(2);
      const after = await prisma.ingestReceipt.findUniqueOrThrow({ where: { projectId_eventId: { projectId: f.project, eventId: input.id } } });
      expect(after.confirmedAt).not.toBeNull();
      expect(after.receivedAt).toEqual(pending.receivedAt);
      const counters = await read<{ ids: number; events: number }>(
        clickhouse,
        'SELECT (SELECT uniqExact(event_id) FROM event_ids WHERE project_id={p:String}) ids,(SELECT sum(events) FROM events_by_minute WHERE project_id={p:String}) events',
        { p: f.project },
      );
      expect(counters[0]).toEqual({ ids: 2, events: 2 });
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  },
  90_000,
);
