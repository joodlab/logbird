import { afterAll, expect, it } from 'vitest';

// The served document must name the deployment (its "try it" requests go there); the committed export must not depend on
// it. Settings are fixed before the app loads its environment. Nothing below is contacted: only /openapi.json is read.
const deployment = 'https://audit.example.invalid';
process.env.APP_URL = deployment;
process.env.DATABASE_URL ??= 'postgresql://ci:ci@127.0.0.1:1/logbird_ci';
process.env.REDIS_URL ??= 'redis://127.0.0.1:1';
process.env.BETTER_AUTH_SECRET ??= 'openapi-servers-test-placeholder-secret';
process.env.CLICKHOUSE_URL ??= 'http://127.0.0.1:1';
process.env.CLICKHOUSE_DATABASE ??= 'logbird';
process.env.CLICKHOUSE_USER ??= 'default';
process.env.CLICKHOUSE_PASSWORD ??= 'ci';

const { app } = await import('./app');
const { committedOpenApiDocument, EXPORT_SERVERS } = await import('./openapi');

afterAll(async () => {
  const [{ prisma }, { clickhouse }, { rateLimitStore }, { closeRetentionQueue }] = await Promise.all([
    import('@logbird/database'),
    import('./clickhouse'),
    import('./rate-limit'),
    import('../../worker/src/queue'),
  ]);
  await Promise.allSettled([rateLimitStore.quit(), closeRetentionQueue(), clickhouse.close(), prisma.$disconnect()]);
});

it("serves the deployment's APP_URL and exports the fixed local default", async () => {
  const response = await app.request('/openapi.json');
  expect(response.status).toBe(200);
  const served = (await response.json()) as { servers: { url: string }[]; paths: object };
  expect(served.servers[0]?.url).toBe(deployment);
  const committed = committedOpenApiDocument(served);
  expect(committed.servers).toEqual(EXPORT_SERVERS);
  expect(committed.servers[0]?.url).toBe('http://localhost:4600');
  // Only `servers` differs: the export carries the served operations unchanged.
  expect(committed.paths).toBe(served.paths);
});
