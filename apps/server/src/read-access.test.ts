import { createHmac } from 'node:crypto';
import type { AuditEvent, ReadScope } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import { maskEvent, maskedEmail, mintViewerToken, scopeWithin, verifyViewerToken, viewerTokenKey } from './read-access';

const secret = viewerTokenKey('x'.repeat(48));
const now = Date.parse('2026-11-22T10:00:00Z');
const input = { keyId: 'key_1', projectId: 'p_1', scope: { tenantId: 't1' }, ttlSeconds: 900 };

describe('viewer tokens', () => {
  it('round-trips within its lifetime and carries the scope', () => {
    const { token, expiresAt } = mintViewerToken(input, secret, now);
    expect(token).toMatch(/^lbv1\.[\w-]+\.[\w-]+$/);
    expect(expiresAt).toBe('2026-11-22T10:15:00.000Z');
    expect(verifyViewerToken(token, secret, now + 60_000)).toMatchObject({ v: 1, kid: 'key_1', p: 'p_1', s: { tenantId: 't1' } });
  });
  it('rejects expiry (beyond 30 s skew), future issue, another secret, tampering and junk', () => {
    const { token } = mintViewerToken(input, secret, now);
    expect(verifyViewerToken(token, secret, now + 900_000 + 29_000)).not.toBeNull();
    expect(verifyViewerToken(token, secret, now + 900_000 + 30_000)).toBeNull();
    expect(verifyViewerToken(token, secret, now - 31_000)).toBeNull();
    expect(verifyViewerToken(token, viewerTokenKey('y'.repeat(48)), now)).toBeNull();
    const [prefix, body, mac] = token.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    for (const changed of [
      { ...payload, s: { tenantId: 't2' } },
      { ...payload, exp: payload.exp + 3600 },
      { ...payload, p: 'p_2' },
    ])
      expect(verifyViewerToken(`${prefix}.${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${mac}`, secret, now)).toBeNull();
    for (const junk of ['', 'lbv1', 'lbv1..', `lbv2.${body}.${mac}`, `${token}.x`, `${prefix}.${body}.${mac.slice(1)}`, 'x'.repeat(9000)])
      expect(verifyViewerToken(junk, secret, now)).toBeNull();
  });
  it('rejects a validly signed payload with an unknown field or a malformed scope', () => {
    const sign = (payload: unknown) => {
      const body = `lbv1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
      return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
    };
    const base = { v: 1, kid: 'k', p: 'p', s: { tenantId: 't1' }, iat: now / 1000, exp: now / 1000 + 60, jti: 'j' };
    expect(verifyViewerToken(sign(base), secret, now)).not.toBeNull();
    expect(verifyViewerToken(sign({ ...base, admin: true }), secret, now)).toBeNull();
    expect(verifyViewerToken(sign({ ...base, s: { tenantId: '' } }), secret, now)).toBeNull();
    expect(verifyViewerToken(sign({ ...base, s: { tenantId: 't1', extra: 1 } }), secret, now)).toBeNull();
  });
});

describe('scopeWithin', () => {
  const site = { tenantId: 't1', target: { type: 'website', id: 's1' } };
  it.each([
    [{ tenantId: 't1' }, null, true],
    [{ tenantId: 't2' }, { tenantId: 't1' }, false],
    [site, { tenantId: 't1' }, true],
    [{ tenantId: 't1' }, site, false],
    [{ tenantId: 't1', target: { type: 'page', id: 's1' } }, site, false],
    [{ tenantId: 't1', target: { type: 'website', id: 's2' } }, site, false],
    [{ tenantId: 't1', actionPrefixes: ['booking.created'] }, { tenantId: 't1', actionPrefixes: ['booking.'] }, true],
    [{ tenantId: 't1', actionPrefixes: ['auth.'] }, { tenantId: 't1', actionPrefixes: ['booking.'] }, false],
    [{ tenantId: 't1' }, { tenantId: 't1', actionPrefixes: ['booking.'] }, false],
    [{ tenantId: 't1', mask: ['ip', 'actor_email'] }, { tenantId: 't1', mask: ['ip'] }, true],
    [{ tenantId: 't1' }, { tenantId: 't1', mask: ['ip'] }, false],
  ] as const)('%j within %j = %s', (child, parent, expected) => {
    expect(scopeWithin(child as ReadScope, parent as ReadScope | null)).toBe(expected);
  });
});

describe('masks', () => {
  const event = {
    id: 'e1',
    projectId: 'p1',
    actor: { id: 'u1', type: 'user', name: 'Lina', email: 'Lina@example.invalid' },
    context: { operationId: '', parentEventId: '', requestId: '', traceId: '', ip: '203.0.113.1', userAgent: 'UA/1' },
    attributes: { 'context.ip': '203.0.113.1', 'metadata.plan': 'pro' },
  } as unknown as AuditEvent;
  it('hides the masked values and keeps the rest, without mutating the input', () => {
    const masked = maskEvent(event, ['ip', 'actor_email']);
    expect(masked.context.ip).toBe('');
    expect(masked.context.userAgent).toBe('UA/1');
    expect(masked.actor?.email).toMatch(/^masked:[0-9a-f]{24}$/);
    expect(masked.attributes).toEqual({ 'metadata.plan': 'pro' });
    expect(event.context.ip).toBe('203.0.113.1');
    expect(maskEvent(event, undefined)).toBe(event);
  });
  it('masks an actor name that is the email too, ID-less or not, and keeps an ordinary name', () => {
    for (const id of ['', 'u1']) {
      const aliased = { ...event, actor: { id, type: '', name: ' lina@example.invalid', email: 'Lina@example.invalid' } } as AuditEvent;
      const masked = maskEvent(aliased, ['actor_email']);
      expect(masked.actor?.email).toMatch(/^masked:[0-9a-f]{24}$/);
      expect(masked.actor?.name).toBe(masked.actor?.email);
      expect(JSON.stringify(masked)).not.toMatch(/example\.invalid/i);
    }
    expect(maskEvent(event, ['actor_email']).actor?.name).toBe('Lina');
  });
  it("shows the impersonator's email as the pseudonym an actor with that address would have, and judges their name by it", () => {
    const support = {
      ...event,
      impersonator: { id: 'sup_1', name: 'Rita <Rita@example.invalid>' },
      attributes: {
        'impersonator.email': 'Rita@example.invalid',
        'impersonator.email.work': 'rita.work@example.invalid',
        'impersonator.type': 'user',
        'metadata.plan': 'pro',
      },
    } as unknown as AuditEvent;
    const masked = maskEvent(support, ['actor_email']);
    const asActor = maskEvent({ ...event, actor: { ...event.actor, email: 'rita@example.invalid' } } as AuditEvent, ['actor_email']);
    expect(masked.attributes['impersonator.email']).toBe(asActor.actor?.email);
    expect(masked.attributes['impersonator.email.work']).toMatch(/^masked:[0-9a-f]{24}$/);
    expect(masked.impersonator).toEqual({ id: 'sup_1', name: asActor.actor?.email });
    expect(masked.attributes['impersonator.type']).toBe('user');
    expect(JSON.stringify(masked)).not.toMatch(/example\.invalid/i);
    // An address only as the name, with no email; an ordinary name stays; other masks leave the impersonator as it is.
    const nameOnly = { ...support, impersonator: { id: 'sup_2', name: 'Solo@example.invalid' }, attributes: {} } as AuditEvent;
    expect(maskEvent(nameOnly, ['actor_email']).impersonator?.name).toMatch(/^masked:[0-9a-f]{24}$/);
    const plain = { ...support, impersonator: { id: 'sup_3', name: 'Rita Support' } } as AuditEvent;
    expect(maskEvent(plain, ['actor_email']).impersonator?.name).toBe('Rita Support');
    expect(maskEvent(support, ['ip']).attributes['impersonator.email']).toBe('Rita@example.invalid');
    expect(maskEvent(support, ['ip']).impersonator?.name).toBe('Rita <Rita@example.invalid>');
  });
  it('hashes emails per project and case-insensitively', () => {
    const key = viewerTokenKey('z'.repeat(48));
    expect(maskedEmail('p1', 'A@example.invalid', key)).toBe(maskedEmail('p1', 'a@example.invalid', key));
    expect(maskedEmail('p1', 'a@example.invalid', key)).not.toBe(maskedEmail('p2', 'a@example.invalid', key));
    expect(maskedEmail('p1', '', key)).toBe('');
  });
});
