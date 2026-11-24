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
  // Only `servers` differs: info, components, paths and everything else are carried over unchanged, and the served
  // document is not modified (the expectation is built from a copy taken before the call).
  const expected = { ...structuredClone(served), servers: [{ url: 'http://localhost:4600', description: 'This Logbird instance' }] };
  const before = structuredClone(served);
  expect(committedOpenApiDocument(served)).toStrictEqual(expected);
  expect(served).toStrictEqual(before);
});

it('documents the project-access 409 on every console project operation so every real conflict body still validates', async () => {
  const spec = await (await app.request('/openapi.json')).json();
  type Code = { const?: string; not?: { const?: string } };
  type Schema = {
    anyOf?: Schema[];
    oneOf?: Schema[];
    properties?: { error?: { required?: string[]; properties?: { code?: Code; details?: { required?: string[] } } } };
  };
  /** Whether one branch admits a code: unless it fixes another code or excludes this one. */
  const branchAdmits = (branch: Schema, code: string) => {
    const rule = branch.properties?.error?.properties?.code;
    return (rule?.const === undefined || rule.const === code) && rule?.not?.const !== code;
  };
  const admits = (schema: Schema, code: string) => (schema.anyOf ?? [schema]).some((branch) => branchAdmits(branch, code));
  let operations = 0;
  for (const [path, item] of Object.entries(spec.paths as Record<string, Record<string, { responses: Record<string, any> }>>)) {
    for (const operation of Object.values(item)) {
      const schema = operation.responses?.['409']?.content?.['application/json']?.schema as Schema | undefined;
      if (!path.startsWith('/api/projects/{projectId}')) {
        expect(JSON.stringify(operation.responses ?? {}), path).not.toContain('project_in_other_workspace');
        continue;
      }
      operations++;
      expect(schema?.oneOf, `${path}: oneOf would reject a body two branches match`).toBeUndefined();
      // The named branch is there, and it alone admits the reserved code, which must carry the workspace details.
      const named = (schema?.anyOf ?? []).filter((branch) => branchAdmits(branch, 'project_in_other_workspace'));
      expect(named, `${path}: branches admitting project_in_other_workspace`).toHaveLength(1);
      expect(named[0]?.properties?.error?.properties?.code?.const, path).toBe('project_in_other_workspace');
      expect(named[0]?.properties?.error?.required, path).toContain('details');
      expect(named[0]?.properties?.error?.properties?.details?.required, path).toEqual(expect.arrayContaining(['workspaceId', 'workspaceName']));
      // The named conflict, and conflicts the routes answer for their own reasons.
      for (const code of [
        'project_in_other_workspace',
        'sample_data_limit',
        'webhook_disabled',
        'webhook_delivery_pending',
        'webhook_secret_overlap_limit',
      ])
        expect(schema && admits(schema, code), `${path} admits ${code}`).toBe(true);
    }
  }
  expect(operations).toBe(37);
});
