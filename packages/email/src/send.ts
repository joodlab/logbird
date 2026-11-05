/**
 * @trailmark/email/send — delivers rendered emails over SMTP (Mailpit locally). Reads SMTP_* / MAIL_FROM / APP_URL.
 */
import nodemailer from 'nodemailer';
import { env } from './env';
import { type EmailDefinition, type RenderedEmail, renderEmail } from './render';
import { type InvitationEmailProps, invitation } from './templates/invitation';
import { type MemberJoinedEmailProps, memberJoined } from './templates/member-joined';
import { type RoleChangedEmailProps, roleChanged } from './templates/role-changed';
import { type SignInCodeEmailProps, signInCode } from './templates/sign-in-code';

const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE === 'true',
  ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
});

/** Props as callers pass them: the product URL defaults to this install's APP_URL. */
export type SendProps<P> = Omit<P, 'appUrl'> & { appUrl?: string };

export interface SentEmail extends RenderedEmail {
  to: string;
  messageId: string;
}

/** Render `email` with `props` and send it to the address in its recipient prop. */
export async function sendEmail<P extends { appUrl: string }>(email: EmailDefinition<P>, props: SendProps<P>): Promise<SentEmail> {
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
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Trailmark-Email': email.id },
  });
  return { ...rendered, to, messageId: info.messageId };
}

export const sendSignInCode = (props: SendProps<SignInCodeEmailProps>) => sendEmail(signInCode, props);
export const sendOrganizationInvitation = (props: SendProps<InvitationEmailProps>) => sendEmail(invitation, props);
export const sendMemberJoined = (props: SendProps<MemberJoinedEmailProps>) => sendEmail(memberJoined, props);
export const sendRoleChanged = (props: SendProps<RoleChangedEmailProps>) => sendEmail(roleChanged, props);

/** SMTP settings safe to print (never credentials). */
export const smtpTarget = () => ({ host: env.SMTP_HOST, port: env.SMTP_PORT, from: env.MAIL_FROM, appUrl: env.APP_URL });
