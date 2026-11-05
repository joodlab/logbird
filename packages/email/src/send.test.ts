import { afterEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: 'fixture' }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));
const props = { email: 'fictional@example.test', code: '123456', purpose: 'sign-in' as const, expiresInMinutes: 5, requestedAt: new Date() };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  sendMail.mockClear();
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
