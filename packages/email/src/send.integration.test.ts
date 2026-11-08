/**
 * Real SMTP against the local Mailpit sink (127.0.0.1:1025, API :8025), which does not offer STARTTLS. Proves the TLS
 * mode fails closed: with SMTP_REQUIRE_TLS=true nothing is authenticated or delivered; without it the code arrives.
 * Skipped when Mailpit is not reachable. Fixtures are fictional and removed afterwards.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const smtpHost = process.env.MAILPIT_SMTP_HOST ?? '127.0.0.1';
const smtpPort = process.env.MAILPIT_SMTP_PORT ?? '1025';
const api = process.env.MAILPIT_API ?? 'http://127.0.0.1:8025';
const recipient = `qa-fix-smtp-tls-${randomUUID().slice(0, 8)}@example.test`;
const query = `?query=${encodeURIComponent(`to:${recipient}`)}`;

const reachable = await fetch(`${api}/api/v1/info`, { signal: AbortSignal.timeout(2000) }).then(
  (r) => r.ok,
  () => false,
);
const props = { email: recipient, code: '246810', purpose: 'sign-in' as const, expiresInMinutes: 5, requestedAt: new Date() };
const messages = async () => (await (await fetch(`${api}/api/v1/search${query}`)).json()) as { messages_count: number };

async function sendWith(requireTls: 'true' | 'false') {
  vi.resetModules();
  vi.stubEnv('AUTH_LOG_SIGN_IN_CODES', 'false');
  vi.stubEnv('SMTP_HOST', smtpHost);
  vi.stubEnv('SMTP_PORT', smtpPort);
  vi.stubEnv('SMTP_SECURE', 'false');
  vi.stubEnv('SMTP_REQUIRE_TLS', requireTls);
  vi.stubEnv('SMTP_USER', '');
  vi.stubEnv('SMTP_PASSWORD', '');
  const { sendSignInCode } = await import('./send');
  return sendSignInCode(props);
}

describe.skipIf(!reachable)('SMTP TLS mode against Mailpit (no STARTTLS)', () => {
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await fetch(`${api}/api/v1/search${query}`, { method: 'DELETE' });
  });

  it('fails closed when STARTTLS is required and nothing is delivered', async () => {
    await expect(sendWith('true')).rejects.toMatchObject({ code: 'ETLS' });
    expect((await messages()).messages_count).toBe(0);
  });

  it('delivers when STARTTLS is not required', async () => {
    const sent = await sendWith('false');
    expect(sent?.to).toBe(recipient);
    await expect.poll(async () => (await messages()).messages_count, { timeout: 5000 }).toBe(1);
  });
});
