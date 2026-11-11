import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  prune: vi.fn(),
  compact: vi.fn(),
  pending: vi.fn(),
  projects: vi.fn(),
  project: vi.fn(),
  lock: vi.fn(),
  recover: vi.fn(),
  expired: vi.fn(),
  recoverRetention: vi.fn(),
}));
vi.mock('@logbird/database', () => ({
  prisma: { ingestReceipt: { findMany: fake.pending }, project: { findMany: fake.projects, findUnique: fake.project } },
  pruneIngestReceipts: fake.prune,
  compactIngestReceiptIndex: fake.compact,
  withProjectLock: fake.lock,
  recoverAbandonedRetention: fake.recoverRetention,
  purgeIngestReceipts: vi.fn(),
}));
vi.mock('@logbird/clickhouse', () => ({
  createMaintenanceClickHouseClient: () => ({}),
  projectMaintenance: (client: unknown) => client,
  hasExpiredEvents: fake.expired,
  purgeProject: vi.fn(),
  rebuildProjectRollups: vi.fn(),
}));
vi.mock('./ingest-recovery', () => ({ recoverProjectIngest: fake.recover, logIngestRecoveryFailure: vi.fn(), prepareReceiptSettlement: vi.fn() }));
vi.mock('./destructive-maintenance', () => ({ beginDestructiveMaintenance: vi.fn(), reconcileDestructiveMaintenance: vi.fn() }));
vi.mock('./project-repair', () => ({ heartbeatMaintenanceRun: vi.fn() }));

import { enforceProjectRetention } from './retention';
import { enforceRetention } from './retention-sweep';

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fake.prune.mockRejectedValue(Object.assign(new Error('statement timeout'), { code: '57014' }));
  fake.pending.mockResolvedValue([{ projectId: 'qa-pending' }]);
  fake.projects.mockResolvedValue([{ id: 'qa-project' }]);
  fake.project.mockResolvedValue({ id: 'qa-project', retentionDays: 30 });
  fake.expired.mockResolvedValue(true);
  fake.lock.mockImplementation(async (_id, work) => work({ retentionRun: { findFirst: async () => ({ status: 'running' }) } }));
  fake.compact.mockResolvedValue({ action: 'skipped_compact' });
});
afterEach(() => vi.restoreAllMocks());

it('continues global recovery and project fan-out after prune timeout and compacts last', async () => {
  await enforceRetention();
  expect(fake.recover).toHaveBeenCalledWith({}, 'qa-pending');
  expect(fake.lock).toHaveBeenCalledWith('qa-project', expect.any(Function));
  expect(fake.recoverRetention).toHaveBeenCalled();
  expect(fake.recover.mock.invocationCallOrder[0]).toBeLessThan(fake.lock.mock.invocationCallOrder[0] as number);
  expect(fake.lock.mock.invocationCallOrder[0]).toBeLessThan(fake.compact.mock.invocationCallOrder[0] as number);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"event":"ingest.receipts_prune_failed","code":"57014"'));
});

it('continues on-demand project retention after prune timeout', async () => {
  await enforceProjectRetention('qa-project');
  expect(fake.prune).toHaveBeenCalledWith('qa-project');
  expect(fake.project).toHaveBeenCalled();
  expect(fake.lock).toHaveBeenCalledWith('qa-project', expect.any(Function));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"projectId":"qa-project","code":"57014"'));
});

it('attempts compaction after failed project work and preserves the essential failure', async () => {
  fake.lock.mockRejectedValue(new Error('retention failed'));
  fake.compact.mockRejectedValue(Object.assign(new Error('not owner'), { code: '42501' }));
  await expect(enforceRetention()).rejects.toThrow(AggregateError);
  expect(fake.compact).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"event":"ingest.receipt_index_compaction_failed","code":"42501"'));
});
