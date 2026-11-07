import { createHash, randomUUID } from 'node:crypto';
import { purgeProject } from '@logbird/clickhouse';
import { createProjectResponseSchema, exportEvidenceRowSchema } from '@logbird/contracts';
import { prisma, storeAuditEvent } from '@logbird/database';
import { expect, it, vi } from 'vitest';
import { app } from './app';
import { clickhouse } from './clickhouse';
import * as ingestion from './ingest';
import { drainTestAudit } from './test-audit';

vi.mock('./clickhouse', async (original) => ({ ...(await original<typeof import('./clickhouse')>()), queryClickhouse: null }));

it('SECURITY-02/03/04/07: role exports retain evidence and correlated completed/failed/aborted receipts', async () => {
  const users: string[] = [];
  let organizationId = '';
  let project: { id: string; slug: string } | undefined;
  let ownerCookie = '';
  const request = (cookie: string, path: string, method = 'GET', body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: { cookie, 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { incoming: { socket: { remoteAddress: '203.0.113.73' } } },
    );
  async function login() {
    const email = `qa-fix-exports-${randomUUID()}@example.test`;
    expect((await request('', '/api/auth/email-otp/send-verification-otp', 'POST', { email, type: 'sign-in' })).status).toBe(200);
    const mailbox = await (await fetch('http://127.0.0.1:8025/api/v1/messages?limit=100')).json();
    const message = mailbox.messages.find((m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === email));
    const content = await (await fetch(`http://127.0.0.1:8025/api/v1/message/${message.ID}`)).json();
    const response = await request('', '/api/auth/sign-in/email-otp', 'POST', { email, otp: content.Text.match(/\b\d{6}\b/)[0] });
    expect(response.status).toBe(200);
    const { user } = await response.json();
    users.push(user.id);
    return {
      id: user.id,
      email,
      cookie: response.headers
        .getSetCookie()
        .map((s) => s.split(';')[0])
        .join('; '),
    };
  }
  async function receipts(requestId: string) {
    await drainTestAudit(organizationId);
    return (
      await clickhouse.query({
        query: 'SELECT payload FROM events WHERE project_id={p:String} AND request_id={id:String} ORDER BY timestamp,event_id',
        query_params: { p: `ws:${organizationId}`, id: requestId },
        format: 'JSONEachRow',
      })
    )
      .json<{ payload: string }>()
      .then((rows) => rows.map((r) => JSON.parse(r.payload)));
  }
  try {
    const owner = await login();
    ownerCookie = owner.cookie;
    const created = await request(owner.cookie, '/api/auth/organization/create', 'POST', {
      name: 'QA Fix exports',
      slug: `qa-fix-exports-${randomUUID()}`,
    });
    expect(created.status).toBe(200);
    organizationId = (await created.json()).id;
    const actors = [owner];
    for (const role of ['admin', 'member']) {
      const user = await login();
      const invitation = await request(owner.cookie, '/api/auth/organization/invite-member', 'POST', { organizationId, email: user.email, role });
      expect(invitation.status).toBe(200);
      expect(
        (await request(user.cookie, '/api/auth/organization/accept-invitation', 'POST', { invitationId: (await invitation.json()).id })).status,
      ).toBe(200);
      expect((await request(user.cookie, '/api/auth/organization/set-active', 'POST', { organizationId })).status).toBe(200);
      actors.push(user);
    }
    await request(owner.cookie, '/api/auth/organization/set-active', 'POST', { organizationId });
    const createdProject = await request(owner.cookie, '/api/projects', 'POST', { name: 'QA Fix export evidence', retentionDays: 90 });
    expect(createdProject.status).toBe(201);
    const result = createProjectResponseSchema.parse(await createdProject.json());
    project = result.project;
    const projectId = project.id;
    const events = Array.from({ length: 205 }, (_, i) => ({
      id: `export-${i.toString().padStart(3, '0')}`,
      action: 'evidence.updated',
      occurredAt: new Date().toISOString(),
      actor: { id: 'effective', name: '=1+1', type: 'user' },
      impersonator: { id: 'support', name: 'Support' },
      executor: { type: 'worker', id: 'worker', jobId: 'job', attempt: 2 },
      changes: [{ field: 'status', before: { state: 'old' }, after: ['new', null] }],
      targets: [{ type: 'record', id: 'record-1' }],
      context: { requestId: 'event-request', ip: '203.0.113.9' },
      description: ['=1+1', '＝1+1', '＋1', '－1', '＠SUM(1)', ' =1+1', ' \t=1+1'][i % 7] ?? '=1+1',
      metadata: { longEvidence: 'Z'.repeat(3000), nested: { array: [null, 1, 'é'] } },
      unknown: { preserved: true },
    }));
    expect(
      (
        await app.request('/v1/events', {
          method: 'POST',
          headers: { authorization: `Bearer ${result.ingestKey.secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(events),
        })
      ).status,
    ).toBe(202);
    const query = `from=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}&q=action:evidence.updated`;
    for (const actor of actors) {
      for (const format of ['jsonl', 'csv', 'jsonl-evidence']) {
        const response = await request(actor.cookie, `/api/projects/${projectId}/export?${query}&format=${format}`);
        expect(response.status).toBe(200);
        const exportId = response.headers.get('X-Logbird-Export-Id');
        expect(exportId).toMatch(/^[a-f0-9-]{36}$/);
        expect(response.headers.get('Content-Disposition')).toContain(exportId);
        expect(response.headers.get('X-Logbird-Export-Schema')).toBe(`${format}/1`);
        const text = await response.text();
        const rows = await receipts(response.headers.get('x-request-id') ?? '');
        expect(rows.map((r) => r.action).sort()).toEqual(['export.completed', 'export.requested']);
        expect(new Set(rows.map((r) => r.metadata.export.exportId)).size).toBe(1);
        for (const row of rows) {
          expect(row.actor.id).toBe(actor.id);
          expect(row.targets[0].id).toBe(projectId);
          expect(row.context.ip).toBe('203.0.113.73');
          expect(row.context.operationId).toBe(row.metadata.export.exportId);
          expect(row.metadata.export.exportId).toBe(exportId);
          expect(row.description).toContain(exportId?.slice(0, 8));
          expect(row.metadata.export).toMatchObject({ format, query: 'action:evidence.updated', projectId });
          expect(row.metadata.export.from).toMatch(/Z$/);
          expect(row).not.toHaveProperty('changes');
          expect(JSON.stringify(row)).not.toContain('longEvidence');
        }
        expect(rows.find((r) => r.action === 'export.completed').metadata.export).toMatchObject({
          rows: 205,
          bytes: Buffer.byteLength(text),
          sha256: createHash('sha256').update(text).digest('hex'),
          schemaVersion: 1,
        });
        const lines = text.trimEnd().split('\n');
        if (format === 'csv') {
          expect(lines).toHaveLength(206);
          expect(lines[0]).toMatch(/^id,timestamp,action,outcome,description,/);
          expect(lines[0]).toContain('schemaVersion');
          expect(lines[0]).toContain('impersonator_id');
          for (const prefix of ['＝1+1', '＋1', '－1', '＠SUM(1)']) expect(text).toContain(`"'${prefix}"`);
          expect(lines[1]).toContain('"\'=1+1"');
          expect(lines[1]).toContain('"support"');
        } else {
          expect(lines).toHaveLength(205);
          expect(new Set(lines.map((line) => JSON.parse(line).event?.id ?? JSON.parse(line).id)).size).toBe(205);
          if (format === 'jsonl-evidence') {
            const evidence = lines.map((line) => exportEvidenceRowSchema.parse(JSON.parse(line)));
            expect(evidence.map((e) => e.payload)).toEqual(events);
            expect(evidence[0]?.exportSchemaVersion).toBe(1);
            expect(evidence[0]?.event.attributes['metadata.longEvidence']).toHaveLength(2048);
          }
        }
      }
    }
    const resilient = await request(owner.cookie, `/api/projects/${projectId}/export?${query}&format=jsonl`);
    expect(resilient.status).toBe(200);
    const unavailable = vi.spyOn(prisma.auditOutbox, 'create').mockRejectedValueOnce(new Error('fictional terminal storage outage'));
    try {
      expect((await resilient.text()).trimEnd().split('\n')).toHaveLength(205);
    } finally {
      unavailable.mockRestore();
    }
    const aborted = await request(owner.cookie, `/api/projects/${projectId}/export?${query}&format=jsonl`);
    if (!aborted.body) throw new Error('Export body missing');
    const reader = aborted.body.getReader();
    await reader.read();
    await reader.cancel();
    const canceled = await receipts(aborted.headers.get('x-request-id') ?? '');
    expect(canceled.map((r) => r.action).sort()).toEqual(['export.failed', 'export.requested']);
    expect(canceled.find((r) => r.action === 'export.failed').metadata.export).toMatchObject({ reason: 'client_aborted' });
    const invalid = await request(owner.cookie, `/api/projects/${projectId}/export?format=jsonl&q=%28`);
    expect(invalid.status).toBe(422);
    expect((await receipts(invalid.headers.get('x-request-id') ?? '')).map((r) => r.action).sort()).toEqual(['export.failed', 'export.requested']);
    for (const [suffix, status, reason] of [
      ['format=jsonl&from=invalid&to=invalid', 422, 'invalid_query'],
      ['format=jsonl&lang=sql&q=1', 503, 'storage_unavailable'],
    ] as const) {
      const early = await request(owner.cookie, `/api/projects/${projectId}/export?${suffix}`);
      expect(early.status).toBe(status);
      const records = await receipts(early.headers.get('x-request-id') ?? '');
      expect(records.map((r) => r.action).sort()).toEqual(['export.failed', 'export.requested']);
      expect(records.find((r) => r.action === 'export.failed').metadata.export.reason).toBe(reason);
    }
    const rejected = vi
      .spyOn(ingestion, 'ingest')
      .mockResolvedValueOnce({ accepted: 0, ids: [], rejected: [{ index: 0, reason: 'duplicate_id_conflict: fixture' }], warnings: [] });
    try {
      const blocked = await request(owner.cookie, `/api/projects/${projectId}/export?${query}&format=jsonl`);
      expect(blocked.status).toBe(503);
      expect((await blocked.json()).error.code).toBe('export_audit_unavailable');
      const queued = await prisma.auditOutbox.findMany({
        where: {
          stream: `ws:${organizationId}`,
          payload: { path: ['context', 'requestId'], equals: blocked.headers.get('x-request-id') },
        },
      });
      expect(queued.map((row) => (row.payload as { action: string }).action).sort()).toEqual(['export.failed', 'export.requested']);
      expect(queued.find((row) => (row.payload as { action: string }).action === 'export.failed')?.payload).toMatchObject({
        metadata: { export: { reason: 'storage_unavailable', rows: 0, bytes: 0 } },
      });
    } finally {
      rejected.mockRestore();
    }
    console.log(
      'SECURITY exports: owner/admin/member x 3 formats, 205 unique rows across pages; original payload deep equality; formula neutralization; completed, failed and canceled receipts verified against Postgres/ClickHouse/Redis/Mailpit.',
    );
  } finally {
    if (project) expect((await request(ownerCookie, `/api/projects/${project.id}?confirm=${project.slug}`, 'DELETE')).status).toBe(204);
    if (organizationId) {
      await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${organizationId}` } });
      await purgeProject(clickhouse, `ws:${organizationId}`);
      await prisma.organization.delete({ where: { id: organizationId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
}, 360_000);

it('waits for a requested receipt already claimed by another replica', async () => {
  const { deliverOutboxEvent, waitForAuditDelivery } = await import('./outbox-delivery');
  const id = randomUUID();
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await storeAuditEvent('ws:qa-export-claim-race', { id, action: 'export.requested' });
    const delivery = deliverOutboxEvent(id, async () => {
      started();
      await blocked;
      return { accepted: 1, rejected: [] };
    });
    await entered;
    let confirmed = false;
    const waiting = waitForAuditDelivery(id).then((ok) => {
      confirmed = ok;
      return ok;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(confirmed).toBe(false);
    release();
    await delivery;
    expect(await waiting).toBe(true);
  } finally {
    release();
    await prisma.auditOutbox.deleteMany({ where: { id } });
  }
});
