import { afterAll, expect, it } from 'vitest';

// The served document must name the deployment (its "try it" requests go there); the committed export must not depend on
// it. Settings are fixed before the app loads its environment. Only /openapi.json is read; no service needs to run (where
// none is configured, the Redis clients try the placeholder address and log refusals).
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
const { committedOpenApiDocument } = await import('./openapi');

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
  const served = (await response.json()) as { servers: { url: string; description: string }[] };
  expect(served.servers).toStrictEqual([{ url: deployment, description: 'This Logbird instance' }]);
  // Only `servers` differs: info, components, paths and everything else are carried over unchanged.
  expect(committedOpenApiDocument(served)).toStrictEqual({
    ...served,
    servers: [{ url: 'http://localhost:4600', description: 'This Logbird instance' }],
  });
});
