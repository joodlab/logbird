import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { notificationSettings } from './env';
import { clientAddress, createRateLimiter, handleWaitlist } from './waitlist';
import { createCloudflareStore } from './waitlist-cloudflare';
import { createNodeStore } from './waitlist-node';

const origin = 'https://site.example.test';
const valid = { email: 'test-waitlist@example.test', interest: 'cloud', name: 'Fictional Tester' };
const req = (input: unknown = valid, headers: Record<string, string> = {}) =>
  new Request(`${origin}/api/waitlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
    body: JSON.stringify(input),
  });
const dependencies = () => ({
  store: vi.fn(async () => undefined),
  allowedOrigins: [origin],
  ip: '192.0.2.1',
  limiter: createRateLimiter(),
  now: () => 1000,
});
describe('waitlist boundary', () => {
  it.each([{ ...valid, email: 'invalid' }, { ...valid, interest: 'invalid' }, { ...valid, message: 'x'.repeat(2001) }, { interest: 'cloud' }])(
    'rejects invalid input without persistence',
    async (input) => {
      const deps = dependencies();
      const response = await handleWaitlist(req(input), deps);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('validation_error');
      expect(deps.store).not.toHaveBeenCalled();
    },
  );
  it.each(['spam', ' '])('acknowledges a honeypot without validation, persistence or email: %j', async (website) => {
    const deps = dependencies();
    expect((await handleWaitlist(req({ website }), deps)).status).toBe(200);
    expect(deps.store).not.toHaveBeenCalled();
  });
  it('rejects cross-origin and unsupported requests', async () => {
    expect((await handleWaitlist(req(valid, { Origin: 'https://other.example.test' }), dependencies())).status).toBe(400);
    expect((await handleWaitlist(req(valid, { 'Content-Type': 'text/plain' }), dependencies())).status).toBe(415);
  });
  it('caps declared and actual UTF-8 bytes, including chunked bodies', async () => {
    expect((await handleWaitlist(req(valid, { 'Content-Length': '8193' }), dependencies())).status).toBe(413);
    expect((await handleWaitlist(req({ ...valid, message: '\u00e9'.repeat(4200) }), dependencies())).status).toBe(413);
  });
  it('rejects malformed JSON', async () => {
    const request = new Request(`${origin}/api/waitlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect((await handleWaitlist(request, dependencies())).status).toBe(400);
  });
  it('enforces five submissions per IP and resets the window', async () => {
    const deps = dependencies();
    for (let index = 0; index < 5; index++) {
      expect((await handleWaitlist(req(), deps)).status).toBe(200);
    }
    const limited = await handleWaitlist(req(), deps);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect((await handleWaitlist(req(), { ...deps, ip: '192.0.2.2' })).status).toBe(200);
    expect((await handleWaitlist(req(), { ...deps, now: () => 61_000 })).status).toBe(200);
  });
  it('redirects native form submissions for success and validation errors', async () => {
    for (const [email, status] of [
      ['test-waitlist@example.test', 'ok'],
      ['invalid', 'validation_error'],
    ]) {
      const request = new Request(`${origin}/api/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
        body: new URLSearchParams({ email: email ?? '', interest: 'self-host' }),
      });
      const response = await handleWaitlist(request, dependencies());
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toBe(`/contact?status=${status}#waitlist-${status}`);
    }
  });
  it('bounds the limiter: new clients are refused while the table is full, and old buckets are swept', () => {
    const limiter = createRateLimiter(2);
    expect(limiter('a', 0)).toBe(true);
    expect(limiter('b', 0)).toBe(true);
    expect(limiter('c', 0)).toBe(false);
    expect(limiter('c', 61_000)).toBe(true);
  });
  it('trusts forwarding headers only for the configured number of proxies', () => {
    expect(clientAddress('10.0.0.2', '203.0.113.9', 0)).toBe('10.0.0.2');
    expect(clientAddress('10.0.0.2', '198.51.100.7, 203.0.113.9', 1)).toBe('203.0.113.9');
    expect(clientAddress('10.0.0.2', 'spoofed, 198.51.100.7, 203.0.113.9', 2)).toBe('198.51.100.7');
    expect(clientAddress('10.0.0.2', null, 1)).toBe('10.0.0.2');
  });
  it('accepts only the listed origins', async () => {
    const response = await handleWaitlist(
      new Request(`${origin}/api/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://elsewhere.example.test' },
        body: JSON.stringify({ email: 'test-waitlist@example.test', interest: 'cloud' }),
      }),
      dependencies(),
    );
    expect(response.status).toBe(400);
  });
  it('reports storage failure as unavailable without exposing details', async () => {
    const response = await handleWaitlist(req(), {
      ...dependencies(),
      store: async () => {
        throw new Error('private connection detail');
      },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'waitlist_unavailable', message: 'The waitlist is unavailable on this deployment.' } });
  });
});
describe('notification settings', () => {
  it('never guesses a mailbox: SMTP on without MAIL_FROM or WAITLIST_NOTIFY_TO disables notifications', () => {
    expect(notificationSettings({})).toEqual({ enabled: false, reason: 'smtp_not_configured' });
    expect(notificationSettings({ SMTP_HOST: 'smtp.example.test' })).toEqual({ enabled: false, reason: 'missing MAIL_FROM and WAITLIST_NOTIFY_TO' });
    expect(notificationSettings({ SMTP_HOST: 'smtp.example.test', MAIL_FROM: 'Site <site@example.test>' })).toEqual({
      enabled: false,
      reason: 'missing WAITLIST_NOTIFY_TO',
    });
    expect(
      notificationSettings({ SMTP_HOST: 'smtp.example.test', MAIL_FROM: 'Site <site@example.test>', WAITLIST_NOTIFY_TO: 'team@example.test' }),
    ).toEqual({
      enabled: true,
      reason: 'ok',
    });
  });
});
describe('storage adapters', () => {
  it('appends a timestamped record and notifies after persistence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'logbird-web-'));
    try {
      const file = join(directory, 'nested/waitlist.jsonl');
      const notify = vi.fn(async () => {
        expect(await readFile(file, 'utf8')).toContain(valid.email);
      });
      const response = await handleWaitlist(req({ ...valid, website: '' }), { ...dependencies(), store: createNodeStore(file, notify) });
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
      const record = JSON.parse((await readFile(file, 'utf8')).trim());
      expect(record).toEqual({ ...valid, receivedAt: '1970-01-01T00:00:01.000Z' });
      expect(record).not.toHaveProperty('website');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('accepts once persisted, retries a failing notification, and logs no personal data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'logbird-web-'));
    try {
      const file = join(directory, 'waitlist.jsonl');
      const notify = vi.fn(async () => {
        throw new Error('smtp down');
      });
      const lines: string[] = [];
      const store = createNodeStore(file, notify, { attempts: 3, delayMs: 1, log: (line) => lines.push(line) });
      const response = await handleWaitlist(req({ ...valid, website: '' }), { ...dependencies(), store });
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(lines).toHaveLength(1));
      expect(notify).toHaveBeenCalledTimes(3);
      expect(lines[0]).toContain('waitlist.notify_failed');
      expect(lines[0]).not.toContain(valid.email);
      expect(await readFile(file, 'utf8')).toContain(valid.email);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('fails closed without a Cloudflare binding, and writes when supplied', async () => {
    expect((await handleWaitlist(req(), { ...dependencies(), store: createCloudflareStore({}) })).status).toBe(503);
    const put = vi.fn(async (_key: string, _value: string) => undefined);
    expect((await handleWaitlist(req(), { ...dependencies(), store: createCloudflareStore({ WAITLIST_KV: { put } }) })).status).toBe(200);
    expect(put).toHaveBeenCalledOnce();
    expect(JSON.parse(put.mock.calls[0]?.[1] ?? '{}').email).toBe(valid.email);
  });
});
