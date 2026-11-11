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

it('continues global recovery and project fan-out after prune timeout without running compaction', async () => {
  await enforceRetention();
  expect(fake.recover).toHaveBeenCalledWith({}, 'qa-pending');
  expect(fake.lock).toHaveBeenCalledWith('qa-project', expect.any(Function));
  expect(fake.recoverRetention).toHaveBeenCalled();
  expect(fake.recover.mock.invocationCallOrder[0]).toBeLessThan(fake.lock.mock.invocationCallOrder[0] as number);
  expect(fake.compact).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"event":"ingest.receipts_prune_failed","code":"57014"'));
});

it('continues on-demand project retention after prune timeout', async () => {
  await enforceProjectRetention('qa-project');
  expect(fake.prune).toHaveBeenCalledWith('qa-project');
  expect(fake.project).toHaveBeenCalled();
  expect(fake.lock).toHaveBeenCalledWith('qa-project', expect.any(Function));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"projectId":"qa-project","code":"57014"'));
});

it('preserves essential failures across retries without running compaction', async () => {
  fake.lock.mockRejectedValue(new Error('retention failed'));
  await expect(enforceRetention()).rejects.toThrow(AggregateError);
  await expect(enforceRetention()).rejects.toThrow(AggregateError);
  expect(fake.compact).not.toHaveBeenCalled();
});

it('continues fan-out after the pending-project query fails', async () => {
  const error = Object.assign(new Error('qa pool unavailable'), { code: 'P2024' });
  fake.pending.mockRejectedValueOnce(error);
  await expect(enforceRetention()).rejects.toMatchObject({ errors: [error] });
  expect(fake.recover).not.toHaveBeenCalled();
  expect(fake.lock).toHaveBeenCalledWith('qa-project', expect.any(Function));
  expect(fake.compact).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(JSON.stringify({ level: 'error', event: 'ingest.pending_projects_failed', code: 'P2024' }));
});

it('preserves recovery after the project-list query fails', async () => {
  const error = Object.assign(new Error('qa pool unavailable'), { code: 'P2024' });
  fake.projects.mockRejectedValueOnce(error);
  await expect(enforceRetention()).rejects.toMatchObject({ errors: [error] });
  expect(fake.recover).toHaveBeenCalledWith({}, 'qa-pending');
  expect(fake.lock).not.toHaveBeenCalled();
  expect(fake.compact).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(JSON.stringify({ level: 'error', event: 'retention.projects_failed', code: 'P2024' }));
});
