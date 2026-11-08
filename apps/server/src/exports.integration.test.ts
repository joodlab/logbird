import { createHash, randomUUID } from 'node:crypto';
import { purgeProject } from '@logbird/clickhouse';
import { createProjectResponseSchema, EXPORT_FORMAT_LABELS, exportEvidenceRowSchema } from '@logbird/contracts';
import { prisma, storeAuditEvent, withProjectLock } from '@logbird/database';
import { enforceProjectRetention } from '@logbird/worker/retention';
import { expect, it, vi } from 'vitest';
import { app } from './app';
import * as projectStorage from './clickhouse';
import { clickhouse } from './clickhouse';
import { reconcileDestructiveMaintenance } from './destructive-maintenance';
import { ApiError } from './errors';
import { drainExportAudits } from './export-stream';
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
    await drainExportAudits();
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
    const eventClock = Date.now();
    const events = Array.from({ length: 205 }, (_, i) => ({
      id: `export-${i.toString().padStart(3, '0')}`,
      action: 'evidence.updated',
      occurredAt: new Date(eventClock).toISOString(),
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
    const incompleteRetention = await prisma.retentionRun.create({ data: { projectId, status: 'failed', retentionDays: 90, cutoff: new Date() } });
    const refused = await request(owner.cookie, `/api/projects/${projectId}/export?${query}&format=jsonl`);
    expect(refused.status).toBe(503);
    expect((await refused.json()).error).toMatchObject({
      code: 'export_project_unreadable',
      message: expect.stringContaining('Retention or deletion is incomplete'),
    });
    const refusedId = refused.headers.get('X-Logbird-Export-Id');
    const refusedStatus = await request(owner.cookie, `/api/workspace/exports/${refusedId}`);
    expect(refusedStatus.status).toBe(200);
    expect(await refusedStatus.json()).toMatchObject({
      state: 'failed',
      reason: 'project_unreadable',
      description: expect.stringContaining('data maintenance is incomplete'),
    });
    await prisma.retentionRun.delete({ where: { id: incompleteRetention.id } });
    for (const actor of actors) {
      for (const format of ['jsonl', 'csv', 'jsonl-evidence'] as const) {
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
          expect(row.metadata.export.formatLabel).toBe(EXPORT_FORMAT_LABELS[format]);
          expect(row.description).toContain(EXPORT_FORMAT_LABELS[format]);
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
    const transaction = prisma.$transaction.bind(prisma);
    let terminalFault = true;
    const unavailable = vi.spyOn(prisma, '$transaction').mockImplementation((...args) => {
      // Boundary validation now has its own short transaction. Inject the terminal draft, not that validation.
      if (terminalFault && args[1] === undefined) {
        terminalFault = false;
        return Promise.reject(new Error('fictional terminal storage outage'));
      }
      return Reflect.apply(transaction, prisma, args);
    });
    try {
      expect((await resilient.text()).trimEnd().split('\n')).toHaveLength(205);
      expect(terminalFault).toBe(false);
    } finally {
      unavailable.mockRestore();
    }
    const recovered = await receipts(resilient.headers.get('x-request-id') ?? '');
    expect(recovered.map((row) => row.action).sort()).toEqual(['export.completed', 'export.requested']);
    expect(recovered.find((row) => row.action === 'export.completed').metadata.export.rows).toBe(205);
    const aborted = await request(owner.cookie, `/api/projects/${projectId}/export?${query}&format=jsonl`);
    if (!aborted.body) throw new Error('Export body missing');
    const reader = aborted.body.getReader();
    await reader.read();
    await reader.cancel();
    const canceled = await receipts(aborted.headers.get('x-request-id') ?? '');
    expect(canceled.map((r) => r.action).sort()).toEqual(['export.failed', 'export.requested']);
    expect(canceled.find((r) => r.action === 'export.failed').metadata.export).toMatchObject({ reason: 'client_aborted' });
    expect(canceled.find((r) => r.action === 'export.failed').description).toContain('Canceled after');
    const invalid = await request(owner.cookie, `/api/projects/${projectId}/export?format=jsonl&q=%28`);
    expect(invalid.status).toBe(422);
    expect((await receipts(invalid.headers.get('x-request-id') ?? '')).map((r) => r.action).sort()).toEqual(['export.failed', 'export.requested']);
    for (const [suffix, status, reason] of [
      ['format=jsonl&from=invalid&to=invalid', 422, 'invalid_query'],
      ['format=jsonl&lang=sql&q=1', 503, 'sql_unavailable'],
    ] as const) {
      const early = await request(owner.cookie, `/api/projects/${projectId}/export?${suffix}`);
      expect(early.status).toBe(status);
      const records = await receipts(early.headers.get('x-request-id') ?? '');
      expect(records.map((r) => r.action).sort()).toEqual(['export.failed', 'export.requested']);
      expect(records.find((r) => r.action === 'export.failed').metadata.export.reason).toBe(reason);
      expect(records.find((r) => r.action === 'export.failed').description).toContain(
        reason === 'sql_unavailable' ? 'SQL mode unavailable' : 'invalid query',
      );
    }
    const rejected = vi.spyOn(ingestion, 'ingest').mockResolvedValueOnce({
      accepted: 0,
      ids: [],
      rejected: [{ index: 0, reason: 'duplicate_id_conflict: fixture', code: 'duplicate_id_conflict' }],
      warnings: [],
    });
    try {
      const blocked = await request(owner.cookie, `/api/projects/${projectId}/export?${query}&format=jsonl`);
      expect(blocked.status).toBe(503);
      expect((await blocked.json()).error.code).toBe('export_audit_unavailable');
      const queued = await prisma.auditOutbox.findMany({
        where: {
          stream: `ws:${organizationId}`,
          payload: { path: ['context', 'requestId'], equals: blocked.headers.get('x-request-id') ?? '' },
        },
      });
      expect(queued.map((row) => (row.payload as { action: string }).action).sort()).toEqual(['export.failed', 'export.requested']);
      expect(queued.find((row) => (row.payload as { action: string }).action === 'export.failed')?.payload).toMatchObject({
        metadata: { export: { reason: 'audit_unavailable', rows: 0, bytes: 0 } },
      });
    } finally {
      rejected.mockRestore();
    }
    // Fresh pre-normalized/post-fence/equal-clock writes are covered by exports-membership.
    // Only an original-clock replay may invalidate; fresh backdated events remain outside the file.
    await ingestion.ingest(
      projectId,
      Array.from({ length: 401 }, (_, i) => ({
        id: `retained-${i}`,
        action: 'evidence.retention',
        occurredAt: new Date(Date.now() - 100 * 86_400_000).toISOString(),
      })),
    );
    const retentionExport = await request(
      owner.cookie,
      `/api/projects/${projectId}/export?format=jsonl&q=action:evidence.retention&from=${new Date(Date.now() - 110 * 86_400_000).toISOString()}`,
    );
    if (!retentionExport.body) throw new Error('Export body missing');
    const retentionReader = retentionExport.body.getReader();
    await retentionReader.read();
    await enforceProjectRetention(projectId);
    await expect(
      (async () => {
        while (!(await retentionReader.read()).done) {
          /* drain */
        }
      })(),
    ).rejects.toThrow();
    expect(
      (await receipts(retentionExport.headers.get('x-request-id') ?? '')).find((row) => row.action === 'export.failed').metadata.export.reason,
    ).toBe('membership_changed');
    const afterPurge = await clickhouse.query({
      query: "SELECT count() n FROM events WHERE project_id={p:String} AND action='evidence.retention'",
      query_params: { p: projectId },
      format: 'JSONEachRow',
    });
    expect(Number((await afterPurge.json<{ n: number }>())[0]?.n)).toBe(0);

    for (const [method, code, retryAfter] of [
      ['stopMaintenance', 'maintenance_pending', 10],
      ['settleProjectInserts', 'ingest_pending', 3],
    ] as const) {
      const concurrent = await request(owner.cookie, `/api/projects/${projectId}/export?${query}&format=jsonl`);
      if (!concurrent.body) throw new Error('Export body missing');
      const reader = concurrent.body.getReader();
      await reader.read();
      const fault = vi
        .spyOn(projectStorage, method)
        .mockRejectedValueOnce(new ApiError(503, code, 'Fictional unsettled write', undefined, retryAfter));
      try {
        const deletion = await request(owner.cookie, `/api/projects/${projectId}?confirm=${project.slug}`, 'DELETE');
        expect(deletion.status).toBe(503);
        expect((await deletion.json()).error.code).toBe(code);
        expect(deletion.headers.get('Retry-After')).toBe(String(retryAfter));
      } finally {
        fault.mockRestore();
      }
      expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).exportDeleteStartedAt).not.toBeNull();
      await expect(
        (async () => {
          while (!(await reader.read()).done) {
            /* drain */
          }
        })(),
      ).rejects.toThrow();
      expect(
        (await receipts(concurrent.headers.get('x-request-id') ?? '')).find((row) => row.action === 'export.failed').metadata.export.reason,
      ).toBe('membership_changed');
      await withProjectLock(projectId, () => reconcileDestructiveMaintenance(projectId));
    }
    const deletionExport = await request(owner.cookie, `/api/projects/${projectId}/export?${query}&format=jsonl`);
    if (!deletionExport.body) throw new Error('Export body missing');
    const deletionReader = deletionExport.body.getReader();
    await deletionReader.read();
    expect((await request(owner.cookie, `/api/projects/${projectId}?confirm=${project.slug}`, 'DELETE')).status).toBe(204);
    project = undefined;
    await expect(
      (async () => {
        while (!(await deletionReader.read()).done) {
          /* drain */
        }
      })(),
    ).rejects.toThrow();
    expect(
      (await receipts(deletionExport.headers.get('x-request-id') ?? '')).find((row) => row.action === 'export.failed').metadata.export.reason,
    ).toBe('membership_changed');
    console.log(
      'SECURITY exports: owner/admin/member x 3 formats, 205 unique rows across pages; original payload deep equality; formula neutralization; completed, failed and canceled receipts verified against Postgres/ClickHouse/Redis/Mailpit.',
    );
  } finally {
    if (project) expect((await request(ownerCookie, `/api/projects/${project.id}?confirm=${project.slug}`, 'DELETE')).status).toBe(204);
    if (organizationId) {
      await prisma.exportLease.deleteMany({ where: { workspaceId: organizationId } });
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
  const org = `qa-export-claim-race-${id}`;
  await prisma.organization.create({ data: { id: org, name: 'QA Export claim race', slug: org, createdAt: new Date() } });
  let started!: () => void, release!: () => void;
  let delivery: Promise<void> | undefined;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await storeAuditEvent(`ws:${org}`, { id, action: 'export.requested' });
    delivery = deliverOutboxEvent(id, async () => {
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
    try {
      await delivery;
    } finally {
      await prisma.auditOutbox.deleteMany({ where: { id } });
      await prisma.organization.deleteMany({ where: { id: org } });
    }
  }
});
