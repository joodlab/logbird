import { afterEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  queues: [] as {
    name: string;
    options: Record<string, unknown>;
    setGlobalConcurrency: ReturnType<typeof vi.fn>;
    upsertJobScheduler: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[],
  workers: [] as {
    name: string;
    process: (job: { name: string; data: Record<string, string>; attemptsMade: number }) => Promise<void>;
    options: Record<string, unknown>;
    close: ReturnType<typeof vi.fn>;
  }[],
  connection: { get: vi.fn(), set: vi.fn() },
  compact: vi.fn(),
  enforce: vi.fn(),
  project: vi.fn(),
  closeRetention: vi.fn(),
  retentionScheduler: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    options: Record<string, unknown>;
    setGlobalConcurrency = vi.fn();
    upsertJobScheduler = vi.fn();
    close = vi.fn();
    constructor(name: string, options: Record<string, unknown>) {
      this.name = name;
      this.options = options;
      fake.queues.push(this);
    }
  },
  Worker: class {
    name: string;
    process: (job: { name: string; data: Record<string, string>; attemptsMade: number }) => Promise<void>;
    options: Record<string, unknown>;
    close = vi.fn();
    on = vi.fn();
    constructor(
      name: string,
      process: (job: { name: string; data: Record<string, string>; attemptsMade: number }) => Promise<void>,
      options: Record<string, unknown>,
    ) {
      this.name = name;
      this.process = process;
      this.options = options;
      fake.workers.push(this);
    }
  },
}));
vi.mock('@logbird/database', () => ({
  closeProjectLocks: vi.fn(),
  prisma: { retentionRun: { findMany: vi.fn(async () => []) }, $disconnect: vi.fn() },
  sweepExpiredAuthRecords: vi.fn(),
  sweepIngestReceipts: vi.fn(),
}));
vi.mock('./env', () => ({ env: { BULLMQ_PREFIX: 'qa-scheduler' } }));
vi.mock('./ingest-recovery', () => ({ probeIngestRecovery: vi.fn() }));
vi.mock('./queue', () => ({
  connection: fake.connection,
  retentionQueueName: 'retention',
  retentionQueue: { upsertJobScheduler: fake.retentionScheduler },
  closeRetentionQueue: fake.closeRetention,
}));
vi.mock('./retention', () => ({ clickhouse: { close: vi.fn() }, enforceProjectRetention: fake.project }));
vi.mock('./retention-sweep', () => ({ enforceRetention: fake.enforce }));
vi.mock('./receipt-index-compaction', () => ({ runReceiptIndexCompaction: fake.compact }));

afterEach(() => vi.restoreAllMocks());

it('schedules compaction hourly on its own single-concurrency queue without retries and cancels it before closing workers', async () => {
  const handlers = new Map<string, () => Promise<void>>();
  vi.spyOn(process, 'once').mockImplementation((event, listener) => {
    handlers.set(String(event), listener as () => Promise<void>);
    return process;
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await import('./index');
  const queue = fake.queues.find((q) => q.name === 'ingest-receipt-index-compaction');
  const compaction = fake.workers.find((w) => w.name === queue?.name);
  const retention = fake.workers.find((w) => w.name === 'retention');
  expect(queue).toBeDefined();
  expect(compaction).toBeDefined();
  expect(retention).toBeDefined();
  expect(queue?.options).toEqual({
    connection: fake.connection,
    prefix: 'qa-scheduler',
    defaultJobOptions: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
  });
  expect(queue?.setGlobalConcurrency).toHaveBeenCalledWith(1);
  expect(compaction?.options).toEqual({ connection: fake.connection, prefix: 'qa-scheduler', concurrency: 1 });
  expect(queue?.upsertJobScheduler).toHaveBeenCalledWith(
    'ingest-receipt-index-hourly',
    { every: 3_600_000 },
    { name: 'ingest-receipt-index.compact', data: {}, opts: { attempts: 1 } },
  );
  expect(fake.retentionScheduler).toHaveBeenCalledWith('retention-hourly', { every: 3_600_000 }, { name: 'retention.enforce', data: {} });

  // A pending rebuild occupies only the dedicated processor, so a queued fence lift can still run.
  let finish: (() => void) | undefined;
  fake.compact.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const rebuilding = compaction?.process({ name: 'ingest-receipt-index.compact', data: {}, attemptsMade: 0 });
  await retention?.process({ name: 'retention.project', data: { projectId: 'qa-fenced' }, attemptsMade: 0 });
  expect(fake.project).toHaveBeenCalledWith('qa-fenced');
  const signal = fake.compact.mock.calls[0]?.[3] as AbortSignal;
  expect(fake.compact).toHaveBeenCalledWith(fake.connection, 'qa-scheduler:ingest-receipt-index-compaction:backoff', 0, signal);
  expect(signal.aborted).toBe(false);
  await compaction?.process({ name: 'ingest-receipt-index.compact', data: {}, attemptsMade: 1 });
  expect(fake.compact.mock.calls[1]?.[2]).toBe(1);

  compaction?.close.mockImplementationOnce(() => {
    expect(signal.aborted).toBe(true);
  });
  expect(handlers.has('SIGTERM')).toBe(true);
  expect(handlers.has('SIGINT')).toBe(true);
  await handlers.get('SIGTERM')?.();
  expect(signal.aborted).toBe(true);
  expect(compaction?.close).toHaveBeenCalledTimes(1);
  expect(queue?.close).toHaveBeenCalledTimes(1);
  expect(queue?.close.mock.invocationCallOrder[0]).toBeLessThan(fake.closeRetention.mock.invocationCallOrder[0] as number);
  finish?.();
  await rebuilding;
  await handlers.get('SIGINT')?.();
  expect(compaction?.close).toHaveBeenCalledTimes(1);
});
