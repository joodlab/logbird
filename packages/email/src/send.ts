/**
 * @logbird/email/send — delivers rendered emails over SMTP (Mailpit locally). Reads SMTP_* / MAIL_FROM / APP_URL.
 */
import nodemailer from 'nodemailer';
import { env } from './env';
import { type EmailDefinition, type RenderedEmail, renderEmail } from './render';
import { type InvitationEmailProps, invitation } from './templates/invitation';
import { type MemberJoinedEmailProps, memberJoined } from './templates/member-joined';
import { type RoleChangedEmailProps, roleChanged } from './templates/role-changed';
import { type SignInCodeEmailProps, signInCode } from './templates/sign-in-code';

if (env.AUTH_LOG_SIGN_IN_CODES === 'true')
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'auth.sign_in_codes_logging_enabled',
      message: 'WARNING: sign-in codes are written to logs. Anyone with log access can sign in. Disable AUTH_LOG_SIGN_IN_CODES after SMTP setup.',
    }),
  );

type SmtpSettings = Pick<typeof env, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_REQUIRE_TLS' | 'SMTP_USER' | 'SMTP_PASSWORD'>;

/** How the SMTP connection is protected: implicit TLS, mandatory STARTTLS, or opportunistic STARTTLS (may be cleartext). */
export type SmtpTlsMode = 'implicit' | 'starttls-required' | 'opportunistic';

export const smtpTlsMode = (settings: Pick<SmtpSettings, 'SMTP_SECURE' | 'SMTP_REQUIRE_TLS'>): SmtpTlsMode =>
  settings.SMTP_SECURE === 'true' ? 'implicit' : settings.SMTP_REQUIRE_TLS === 'true' ? 'starttls-required' : 'opportunistic';

/**
 * Nodemailer transport options. `requireTLS` makes Nodemailer refuse to authenticate or send when the server does not
 * advertise STARTTLS or the upgrade fails, so a downgrade cannot expose credentials or codes. Certificate verification
 * stays on (no `rejectUnauthorized: false`).
 */
export function smtpTransportOptions(settings: SmtpSettings) {
  const mode = smtpTlsMode(settings);
  return {
    host: settings.SMTP_HOST,
    port: settings.SMTP_PORT,
    secure: mode === 'implicit',
    requireTLS: mode === 'starttls-required',
    ...(settings.SMTP_USER ? { auth: { user: settings.SMTP_USER, pass: settings.SMTP_PASSWORD } } : {}),
  };
}

const loopback = (host: string) => host === 'localhost' || host === '::1' || host.startsWith('127.');
if (env.SMTP_HOST && !loopback(env.SMTP_HOST) && smtpTlsMode(env) === 'opportunistic')
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'email.smtp_tls_not_required',
      message: 'SMTP may fall back to cleartext. For a provider on port 587 set SMTP_REQUIRE_TLS=true; for implicit TLS (465) set SMTP_SECURE=true.',
    }),
  );

const transport = nodemailer.createTransport(smtpTransportOptions(env));

/** Props as callers pass them: the product URL defaults to this install's APP_URL. */
export type SendProps<P> = Omit<P, 'appUrl'> & { appUrl?: string };

export interface SentEmail extends RenderedEmail {
  to: string;
  messageId: string;
}

/** Render `email` with `props` and send it to the address in its recipient prop. */
export async function sendEmail<P extends { appUrl: string }>(email: EmailDefinition<P>, props: SendProps<P>): Promise<SentEmail> {
  if (!env.SMTP_HOST) throw new Error('SMTP_HOST is not configured');
  const full = { ...props, appUrl: props.appUrl ?? env.APP_URL } as P;
  const to = String(full[email.recipient]);
  const rendered = await renderEmail(email, full);
  const info = await transport.sendMail({
    from: env.MAIL_FROM,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    // RFC 3834: tells mail servers and vacation responders not to auto-reply.
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Logbird-Email': email.id },
  });
  return { ...rendered, to, messageId: info.messageId };
}

export const sendSignInCode = async (props: SendProps<SignInCodeEmailProps>) => {
  if (env.AUTH_LOG_SIGN_IN_CODES === 'true' && props.purpose === 'sign-in') {
    console.log(JSON.stringify({ level: 'warn', event: 'auth.sign_in_code', email: props.email, code: props.code }));
    if (!env.SMTP_HOST) return;
  }
  return sendEmail(signInCode, props);
};
export const sendOrganizationInvitation = (props: SendProps<InvitationEmailProps>) => sendEmail(invitation, props);
export const sendMemberJoined = (props: SendProps<MemberJoinedEmailProps>) => sendEmail(memberJoined, props);
export const sendRoleChanged = (props: SendProps<RoleChangedEmailProps>) => sendEmail(roleChanged, props);

/** SMTP settings safe to print (never credentials). */
export const smtpTarget = () => ({ host: env.SMTP_HOST, port: env.SMTP_PORT, tls: smtpTlsMode(env), from: env.MAIL_FROM, appUrl: env.APP_URL });
