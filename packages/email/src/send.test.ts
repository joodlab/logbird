import { afterEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: 'fixture' }));
const createTransport = vi.hoisted(() => vi.fn(() => ({ sendMail })));
vi.mock('nodemailer', () => ({ default: { createTransport } }));
const props = { email: 'fictional@example.test', code: '123456', purpose: 'sign-in' as const, expiresInMinutes: 5, requestedAt: new Date() };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  sendMail.mockClear();
  createTransport.mockClear();
});

describe('explicit sign-in log fallback', () => {
  it('warns at boot and bypasses SMTP only when explicitly enabled without a host', async () => {
    vi.stubEnv('AUTH_LOG_SIGN_IN_CODES', 'true');
    vi.stubEnv('SMTP_HOST', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { sendSignInCode } = await import('./send');
    await sendSignInCode(props);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('auth.sign_in_codes_logging_enabled'));
    expect(JSON.parse(log.mock.calls[0]?.[0])).toMatchObject({ event: 'auth.sign_in_code', code: '123456', email: props.email });
    expect(sendMail).not.toHaveBeenCalled();
  });
  it('fails without SMTP when disabled, without logging a code', async () => {
    vi.stubEnv('AUTH_LOG_SIGN_IN_CODES', 'false');
    vi.stubEnv('SMTP_HOST', '');
    const log = vi.spyOn(console, 'log');
    const { sendSignInCode } = await import('./send');
    await expect(sendSignInCode(props)).rejects.toThrow('SMTP_HOST');
    expect(log).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });
  it('delivers through configured SMTP with logging off', async () => {
    vi.stubEnv('AUTH_LOG_SIGN_IN_CODES', 'false');
    vi.stubEnv('SMTP_HOST', 'smtp.example.test');
    const log = vi.spyOn(console, 'log');
    const { sendSignInCode } = await import('./send');
    await sendSignInCode(props);
    expect(sendMail).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
  });
  it('does not bypass SMTP for other OTP purposes', async () => {
    vi.stubEnv('AUTH_LOG_SIGN_IN_CODES', 'true');
    vi.stubEnv('SMTP_HOST', '');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log');
    const { sendSignInCode } = await import('./send');
    await expect(sendSignInCode({ ...props, purpose: 'email-verification' })).rejects.toThrow('SMTP_HOST');
    expect(log).not.toHaveBeenCalled();
  });
});

describe('SMTP TLS mode', () => {
  const smtp = (values: Record<string, string>) => {
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'SMTP_USER', 'SMTP_PASSWORD']) vi.stubEnv(key, values[key] ?? '');
  };
  const transportOptions = () => (createTransport.mock.calls[0] as unknown[] | undefined)?.[0];

  it('requires STARTTLS before AUTH when SMTP_REQUIRE_TLS=true (provider port 587)', async () => {
    smtp({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_REQUIRE_TLS: 'true', SMTP_USER: 'fixture-token', SMTP_PASSWORD: 'fixture-token' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { smtpTarget } = await import('./send');
    expect(transportOptions()).toEqual({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'fixture-token', pass: 'fixture-token' },
    });
    expect(transportOptions()).not.toHaveProperty('tls');
    expect(smtpTarget()).toMatchObject({ tls: 'starttls-required' });
    expect(smtpTarget()).not.toHaveProperty('password');
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses implicit TLS when SMTP_SECURE=true', async () => {
    smtp({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_REQUIRE_TLS: 'true' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { smtpTarget } = await import('./send');
    expect(transportOptions()).toMatchObject({ port: 465, secure: true, requireTLS: false });
    expect(smtpTarget()).toMatchObject({ tls: 'implicit' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns at boot when a non-loopback host may fall back to cleartext', async () => {
    smtp({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { smtpTarget } = await import('./send');
    expect(transportOptions()).toMatchObject({ secure: false, requireTLS: false });
    expect(smtpTarget()).toMatchObject({ tls: 'opportunistic' });
    expect(JSON.parse(warn.mock.calls[0]?.[0])).toMatchObject({ event: 'email.smtp_tls_not_required' });
  });

  it('does not warn for a loopback mail sink', async () => {
    smtp({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await import('./send');
    expect(warn).not.toHaveBeenCalled();
  });
});
