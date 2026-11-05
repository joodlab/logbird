import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { prisma } from '@trailmark/database';
import { generateApiKey } from '../apps/server/src/keys';
import { ApiError, createClient as forgeClient } from '../experiments/forge/public';
import { createClient } from '../experiments/hey-api/public/client';
import { publicEventDetail, publicSearchEvents } from '../experiments/hey-api/public/sdk.gen';

const baseUrl = 'http://127.0.0.1:4641';
let keyId: string | undefined;
try {
  const project = await prisma.project.findFirstOrThrow({ where: { name: 'StayDesk', organization: { slug: 'acme' } } });
  const material = generateApiKey('read');
  const key = await prisma.apiKey.create({
    data: { projectId: project.id, name: 'SDK spike temporary read key', kind: 'read', hash: material.hash, prefix: material.prefix },
  });
  keyId = key.id;
  const range = { from: new Date(Date.now() - 89 * 86_400_000).toISOString(), to: new Date().toISOString(), q: 'action:hotel.*', limit: 1 };
  const forge = forgeClient({ baseUrl, token: material.secret });
  const hey = createClient({ baseUrl, auth: material.secret });
  const results: object[] = [];
  for (const generator of ['forge', 'hey-api']) {
    const search = async (query: typeof range & { cursor?: string }) =>
      generator === 'forge' ? forge.events.publicSearchEvents(query) : (await publicSearchEvents({ client: hey, query, throwOnError: true })).data;
    const first = await search(range);
    assert.ok(first && first.data.length === 1 && first.nextCursor, `${generator}: needs two matching demo events`);
    const second = await search({ ...range, cursor: first.nextCursor });
    assert.ok(second && second.data.length === 1);
    assert.notEqual(first.data[0]?.id, second.data[0]?.id);
    const eventId = first.data[0]?.id;
    assert.ok(eventId);
    const detail =
      generator === 'forge'
        ? await forge.events.publicEventDetail({ eventId })
        : (await publicEventDetail({ client: hey, path: { eventId }, throwOnError: true })).data;
    assert.equal(detail?.event.id, eventId);
    const bad = await publicSearchEvents({ client: hey, query: { ...range, limit: 0 } });
    assert.equal(bad.response?.status, 422);
    assert.ok(bad.error?.error.code);
    if (generator === 'forge')
      await assert.rejects(
        () => forge.events.publicSearchEvents({ ...range, limit: 0 }),
        (error: unknown) => error instanceof ApiError && error.status === 422,
      );
    results.push({ generator, search: 'pass (q + absolute range)', cursor: 'pass (distinct second page)', detail: 'pass', invalidLimit: 422 });
  }
  const unauthorized = await publicSearchEvents({ client: createClient({ baseUrl }) });
  assert.equal(unauthorized.response?.status, 401);
  await assert.rejects(
    () => forgeClient({ baseUrl, token: 'invalid' }).events.publicSearchEvents(),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  await mkdir('experiments', { recursive: true });
  await writeFile(
    'experiments/runtime-results.json',
    `${JSON.stringify({ measuredAt: new Date().toISOString(), baseUrl, results, missingOrInvalidAuth: 401 }, null, 2)}\n`,
  );
  console.log('Both generated clients: real search, cursor, detail, 422 and 401 passed.');
} finally {
  // Delete only the exact throwaway key created by this run; existing keys stay intact.
  if (keyId) await prisma.apiKey.delete({ where: { id: keyId } });
  await prisma.$disconnect();
}
