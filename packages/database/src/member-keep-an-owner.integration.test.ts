import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { hasWorkspaceRole, isWorkspaceNeedsOwnerError } from './membership-roles';

// The member_keep_an_owner trigger (migration 20261124120000) against real Postgres, with real concurrent connections.
// Each case builds its own fictional organization and members and removes them; nothing else is touched.
const ITERATIONS = Number(process.env.OWNER_RACE_ITERATIONS ?? 300);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const users: string[] = [];
const organizations: string[] = [];

beforeAll(async () => {
  // Two fictional users, reused by every case (members are per organization).
  for (const name of ['owner-a', 'owner-b']) {
    const id = `t3-owner-race-${name}-${randomUUID()}`;
    await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, now(), now())`, [
      id,
      name,
      `${id}@example.invalid`,
    ]);
    users.push(id);
  }
});
afterAll(async () => {
  for (const id of organizations) await pool.query('DELETE FROM organization WHERE id = $1', [id]);
  await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [users]);
  await pool.end();
});

async function workspace(roles: [string, string]) {
  const id = `t3-owner-race-${randomUUID()}`;
  await pool.query(`INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, 'T3 Owner Race Example', $1, now())`, [id]);
  organizations.push(id);
  const members: string[] = [];
  for (const [index, role] of roles.entries()) {
    const member = randomUUID();
    await pool.query(`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, now())`, [
      member,
      id,
      users[index],
      role,
    ]);
    members.push(member);
  }
  return { id, members };
}
const owners = async (organizationId: string) =>
  Number((await pool.query(`SELECT count(*) AS n FROM member WHERE "organizationId" = $1 AND logbird_is_owner(role)`, [organizationId])).rows[0].n);

/** One statement in its own transaction on its own connection, at the given isolation level. */
async function attempt(sql: string, params: unknown[], isolation = 'READ COMMITTED') {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await client.query(sql, params);
    await client.query('COMMIT');
    return 'ok' as const;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // The connection may already be broken; the error above is what counts.
    if (isWorkspaceNeedsOwnerError(error)) return 'needs-owner' as const;
    if ((error as { code?: string }).code === '40001') return 'serialization' as const;
    throw error;
  } finally {
    client.release();
  }
}
const leave = (member: string): [string, unknown[]] => ['DELETE FROM member WHERE id = $1', [member]];
const demote = (member: string): [string, unknown[]] => [`UPDATE member SET role = 'member' WHERE id = $1`, [member]];

it('defines "is an owner" in SQL exactly as hasWorkspaceRole does in the application', async () => {
  const roles = [
    'owner',
    'admin',
    'member',
    'owner,admin',
    'admin,owner',
    ' owner ',
    'admin, owner',
    'owners',
    'co-owner',
    'Owner',
    '',
    ',',
    'owner,',
    ',owner',
    // JavaScript's trim() removes every Unicode space and line terminator, not only the ASCII space.
    ...[0x09, 0x0a, 0x0d, 0xa0, 0x20_28, 0x30_00, 0xfe_ff].map((c) => `${String.fromCharCode(c)}owner${String.fromCharCode(c)}`),
    `admin,${String.fromCharCode(0x09)}owner`,
  ];
  for (const role of roles) {
    const sql = (await pool.query('SELECT logbird_is_owner($1) AS owner', [role])).rows[0].owner as boolean;
    expect(sql, JSON.stringify(role)).toBe(hasWorkspaceRole(role, ['owner']));
  }
  expect((await pool.query('SELECT logbird_is_owner(NULL) AS owner')).rows[0].owner).toBe(false);
});

it('refuses removing or demoting the last owner, and allows it while another owner remains', async () => {
  const solo = await workspace(['owner', 'member']);
  expect(await attempt(...leave(solo.members[0] as string))).toBe('needs-owner');
  expect(await attempt(...demote(solo.members[0] as string))).toBe('needs-owner');
  // Non-owners come and go freely.
  expect(await attempt(...leave(solo.members[1] as string))).toBe('ok');
  // Combined roles count as an owner, on both sides.
  const combined = await workspace(['owner,admin', 'owner']);
  expect(await attempt(...leave(combined.members[1] as string))).toBe('ok');
  expect(await attempt(...leave(combined.members[0] as string))).toBe('needs-owner');
  expect(await owners(combined.id)).toBe(1);
});

it(`never lets two concurrent removals take the last two owners (${ITERATIONS}× each pairing)`, async () => {
  for (const [label, first, second] of [
    ['leave + leave', leave, leave],
    ['remove + leave', leave, leave],
    ['demote + leave', demote, leave],
  ] as const) {
    for (let i = 0; i < ITERATIONS; i++) {
      const w = await workspace(['owner', 'owner']);
      const results = await Promise.all([attempt(...first(w.members[0] as string)), attempt(...second(w.members[1] as string))]);
      expect(
        results.filter((r) => r === 'ok'),
        `${label} #${i}: ${results}`,
      ).toHaveLength(1);
      expect(
        results.filter((r) => r === 'needs-owner'),
        `${label} #${i}: ${results}`,
      ).toHaveLength(1);
      expect(await owners(w.id), `${label} #${i}`).toBe(1);
    }
  }
}, 600_000);

it('holds the second removal until the first commits, then refuses it (the interleaving that defeats a plain check)', async () => {
  const w = await workspace(['owner', 'owner']);
  const a = await pool.connect();
  try {
    await a.query('BEGIN');
    await a.query(...leave(w.members[0] as string));
    // B starts while A is still open: it must wait, not count A's uncommitted removal as an owner and pass.
    const b = attempt(...leave(w.members[1] as string));
    const settled = await Promise.race([b.then(() => 'settled'), new Promise((r) => setTimeout(() => r('waiting'), 500))]);
    expect(settled).toBe('waiting');
    await a.query('COMMIT');
    expect(await b).toBe('needs-owner');
  } finally {
    // Never return a connection to the pool with its transaction (and the organization lock) still open.
    await a.query('ROLLBACK').catch(() => undefined);
    a.release();
  }
  expect(await owners(w.id)).toBe(1);
});

it('refuses owner removals under REPEATABLE READ and SERIALIZABLE, where a stale count could not be caught', async () => {
  // SERIALIZABLE too: a concurrent READ COMMITTED removal is outside Postgres's serializable checks.
  for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) {
    const w = await workspace(['owner', 'owner']);
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const error = await client.query(...leave(w.members[0] as string)).then(
        () => null,
        (e: { code?: string }) => e,
      );
      expect(error?.code, isolation).toBe('LB410');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await owners(w.id), isolation).toBe(2);
  }
});

it('leaves non-owner changes alone at any isolation level', async () => {
  const w = await workspace(['owner', 'owner']);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(`UPDATE member SET "createdAt" = now() WHERE id = $1`, [w.members[0]]);
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  expect(await owners(w.id)).toBe(2);
});

it('still lets an organization be deleted with its members, and leaves an already ownerless one working', async () => {
  const w = await workspace(['owner', 'owner,admin']);
  expect(await attempt('DELETE FROM organization WHERE id = $1', [w.id])).toBe('ok');
  expect(Number((await pool.query('SELECT count(*) AS n FROM member WHERE "organizationId" = $1', [w.id])).rows[0].n)).toBe(0);
  // Existing data the trigger never checked: an organization with members but no owner keeps working.
  const ownerless = await workspace(['admin', 'member']);
  expect(await attempt(`UPDATE member SET role = 'admin' WHERE id = $1`, [ownerless.members[1]])).toBe('ok');
  expect(await attempt(...leave(ownerless.members[1] as string))).toBe('ok');
});
