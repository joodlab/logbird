import { queryErrorDetailsSchema } from '@logbird/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { attacks, positives } from '../../../packages/clickhouse/test-fixtures/sql';
import { client, endpoint, login } from '../../../scripts/http';

const enabled = process.env.SEARCH_V2_HTTP === '1';
describe.runIf(enabled)('Search v2 HTTP on real local services', () => {
  let cookie: string, p: string, api: ReturnType<typeof client>, readKey: string;
  // Fixture projects live in the demo workspace only for the duration of the suite: deleting them afterwards keeps
  // "Search v2 security …" projects from piling up in the Projects list and from becoming the landing project.
  const created: { id: string; slug: string }[] = [];
  afterAll(async () => {
    if (!api) return;
    for (const project of created) {
      const r = await api(`/api/projects/${project.id}?${new URLSearchParams({ confirm: project.slug })}`, 'DELETE');
      expect(r.status).toBe(204);
    }
  });
  it('creates two isolated fictional projects with distinct events', async () => {
    cookie = await login('demo@logbird.local');
    api = client(cookie);
    const me = await (await api('/api/me')).json();
    await api('/api/auth/organization/set-active', 'POST', { organizationId: me.organizations.find((o: { name: string }) => o.name === 'Jood').id });
    for (const n of ['a', 'b']) {
      const c = await (await api('/api/projects', 'POST', { name: `Search v2 security ${n} ${Date.now()}` })).json();
      created.push({ id: c.project.id, slug: c.project.slug });
      if (n === 'a') {
        p = c.project.id;
        readKey = (await (await api(`/api/projects/${p}/keys`, 'POST', { name: 'Security read', kind: 'read' })).json()).secret;
      }
      const r = await fetch(`${endpoint}/v1/events`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.ingestKey.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `http-search-fixture-${n}`,
          action: `fixture.${n}`,
          executor: { attempt: 3 },
          targets: [{ type: 'booking', id: 'bk_1' }],
        }),
      });
      expect(r.status).toBe(202);
    }
  });
  it.each(attacks)('rejects SQL attack %s', async (q) => {
    const r = await fetch(`${endpoint}/api/projects/${p}/events?${new URLSearchParams({ lang: 'sql', q })}`, { headers: { cookie } });
    expect(r.status).toBe(422);
    const e = await r.json();
    expect(e.error.code).toBe('invalid_query');
    queryErrorDetailsSchema.parse(e.error.details);
  });
  it.each(positives)('accepts SQL expression %s', async (q) => {
    const r = await api(`/api/projects/${p}/events?${new URLSearchParams({ lang: 'sql', q })}`);
    expect(r.status).toBe(200);
  });
  it('enforces project isolation across all read surfaces and read-key API', async () => {
    const q = new URLSearchParams({ lang: 'sql', q: '1 OR 1' });
    const events = await (await api(`/api/projects/${p}/events?${q}`)).json();
    expect(events.data.map((e: { id: string }) => e.id)).toEqual(['http-search-fixture-a']);
    const hist = await (await api(`/api/projects/${p}/histogram?${q}`)).json();
    expect(hist.buckets.reduce((n: number, b: { total: number }) => n + b.total, 0)).toBe(1);
    const facet = await (await api(`/api/projects/${p}/facets?${q}&field=action`)).json();
    expect(facet.values.map((v: { value: string }) => v.value)).toEqual(['fixture.a']);
    const out = await (await api(`/api/projects/${p}/export?${q}&format=jsonl`)).text();
    expect(out).toContain('fixture.a');
    expect(out).not.toContain('fixture.b');
    for (const path of ['overview', `live?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`, 'fields']) {
      const r = await api(`/api/projects/${p}/${path}${path.includes('?') ? '&' : '?'}${q}`);
      expect(r.status).toBe(200);
    }
    expect((await api(`/api/projects/${p}/entities/target/booking%3Abk_1?${q}`)).status).toBe(200);
    const activity = await (await api(`/api/workspace/activity?${q}`)).json();
    expect(activity.data.every((e: { projectId: string }) => e.projectId.startsWith('ws:'))).toBe(true);
    const openapi = await (await api('/openapi.json')).json();
    expect(openapi.paths['/api/projects/{projectId}/suggest']).toBeDefined();
    const pub = await fetch(`${endpoint}/v1/events?${q}`, { headers: { Authorization: `Bearer ${readKey}` } });
    expect(pub.status).toBe(422);
  });
  it('maps CPU-heavy SQL timeout to a typed limit', async () => {
    const projects = await (await api('/api/projects')).json();
    const demo = projects.data.find((p: { name: string }) => p.name === 'JoodCMS');
    expect(demo).toBeTruthy();
    const q = "match(description, concat('(?:', replaceRegexpAll(description,'[^a-zA-Z0-9]',''), '){10}'))";
    const r = await fetch(
      `${endpoint}/api/projects/${demo.id}/events?${new URLSearchParams({ lang: 'sql', q, from: new Date(Date.now() - 90 * 86_400_000).toISOString(), limit: '1' })}`,
      { headers: { cookie } },
    );
    expect(r.status).toBe(422);
    expect((await r.json()).error.details).toMatchObject({ lang: 'sql', reason: 'limit' });
  }, 25_000);
  it('returns typed query errors and suggestions', async () => {
    const r = await fetch(`${endpoint}/api/projects/${p}/events?q=attempt:>abc`, { headers: { cookie } });
    expect(r.status).toBe(422);
    expect((await r.json()).error.details).toMatchObject({ reason: 'type', start: 9, end: 12 });
    expect((await (await api(`/api/projects/${p}/suggest?field=action`)).json()).values[0].value).toBe('fixture.a');
  });
});
