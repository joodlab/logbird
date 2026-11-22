import { readFile } from 'node:fs/promises';
import type { Prisma } from '@logbird/database';

export async function loadWebhookReconciliation() {
  const guide = await readFile(new URL('../../../docs/self-hosting.md', import.meta.url), 'utf8');
  const statement = guide.match(/WITH bounds AS \([\s\S]+?RETURNING id;/)?.[0];
  if (!statement) throw new Error('Missing operator reconciliation statement');
  const parameters = ['endpoint_id', 'project_id', 'original_rollout', 'checkpoint', 'evidence_ref', 'audit_namespace'];
  const sql = statement.replace(/:'(\w+)'/g, (_, name: string) => `$${parameters.indexOf(name) + 1}::text`);
  return (db: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>, endpoint: string, project: string, floor: Date, checkpoint: Date) =>
    db.$queryRawUnsafe<{ id: string }[]>(sql, endpoint, project, floor.toISOString(), checkpoint.toISOString(), 'qa-backup', '{logbird-t2w}');
}
