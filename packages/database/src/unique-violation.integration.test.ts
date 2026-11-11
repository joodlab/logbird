import { afterAll, expect, it } from 'vitest';
import { isUniqueViolation, prisma } from './index';

// Proves the helper against the error shape the real Prisma client + adapter-pg produce for a raw-query unique
// violation (the shape claimIngestReceipts sees during REINDEX CONCURRENTLY). Raises the SQLSTATE without writing rows.
afterAll(() => prisma.$disconnect());

it('recognizes a real raw-query unique violation from Prisma', async () => {
  const error = await prisma.$queryRaw`DO $$ BEGIN RAISE unique_violation USING MESSAGE = 'qa unique violation'; END $$`.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).not.toBeNull();
  expect(isUniqueViolation(error)).toBe(true);
});

it('recognizes a real executeRaw unique violation and rejects other SQLSTATEs', async () => {
  const unique = await prisma.$executeRaw`DO $$ BEGIN RAISE unique_violation USING MESSAGE = 'qa unique violation'; END $$`.then(
    () => null,
    (e: unknown) => e,
  );
  expect(isUniqueViolation(unique)).toBe(true);
  const other = await prisma.$queryRaw`DO $$ BEGIN RAISE query_canceled USING MESSAGE = 'qa cancel'; END $$`.then(
    () => null,
    (e: unknown) => e,
  );
  expect(other).not.toBeNull();
  expect(isUniqueViolation(other)).toBe(false);
});
