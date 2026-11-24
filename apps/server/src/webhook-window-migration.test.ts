import { readFileSync } from 'node:fs';
import {
  DEFAULT_WEBHOOK_DELIVERY_WINDOW_SECONDS,
  MAX_WEBHOOK_DELIVERY_WINDOW_SECONDS,
  MIN_WEBHOOK_DELIVERY_WINDOW_SECONDS,
} from '@logbird/contracts';
import { expect, it } from 'vitest';

it('migrates existing webhook endpoints to the same delivery window that create uses', () => {
  // The migration is SQL and cannot import the constant; this keeps the two from drifting apart.
  const sql = readFileSync(
    new URL('../../../packages/database/prisma/migrations/20261124100000_webhook_delivery_window/migration.sql', import.meta.url),
    'utf8',
  );
  expect(sql).toContain(`ADD COLUMN "deliveryWindowSeconds" INTEGER DEFAULT ${DEFAULT_WEBHOOK_DELIVERY_WINDOW_SECONDS};`);
  expect(sql).toContain(`BETWEEN ${MIN_WEBHOOK_DELIVERY_WINDOW_SECONDS} AND ${MAX_WEBHOOK_DELIVERY_WINDOW_SECONDS}`);
});
