import nodemailer from 'nodemailer';
import { env } from './env';
import { type EmailDefinition, type RenderedEmail, renderEmail } from './render';
import { type InvitationEmailProps, invitation } from './templates/invitation';
import { type MemberJoinedEmailProps, memberJoined } from './templates/member-joined';
import { type RoleChangedEmailProps, roleChanged } from './templates/role-changed';
import { type SignInCodeEmailProps, signInCode } from './templates/sign-in-code';

export { clientIp, describeUserAgent, primaryRole } from './format';
export type { EmailDefinition, RenderedEmail } from './render';
export { renderEmail } from './render';
export type { InvitationEmailProps } from './templates/invitation';
export type { MemberJoinedEmailProps } from './templates/member-joined';
export type { RoleChangedEmailProps } from './templates/role-changed';
export type { OtpPurpose, SignInCodeEmailProps } from './templates/sign-in-code';

/** Every email Trailmark sends. Tests and previews iterate over this. */
export const emails = { signInCode, invitation, memberJoined, roleChanged } as const;

const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE === 'true',
  ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
});

/** Props as callers pass them: the product URL defaults to this install's APP_URL. */
type SendProps<P> = Omit<P, 'appUrl'> & { appUrl?: string };

async function send<P extends { appUrl: string }>(email: EmailDefinition<P>, to: string, props: SendProps<P>): Promise<RenderedEmail> {
  const rendered = await renderEmail(email, { ...props, appUrl: props.appUrl ?? env.APP_URL } as P);
  await transport.sendMail({
    from: env.MAIL_FROM,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    // RFC 3834: tells mail servers and vacation responders not to auto-reply.
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Trailmark-Email': email.id },
  });
  return rendered;
}

export const sendSignInCode = (props: SendProps<SignInCodeEmailProps>) => send(signInCode, props.email, props);
export const sendOrganizationInvitation = (props: SendProps<InvitationEmailProps>) => send(invitation, props.email, props);
export const sendMemberJoined = (props: SendProps<MemberJoinedEmailProps>) => send(memberJoined, props.inviterEmail, props);
export const sendRoleChanged = (props: SendProps<RoleChangedEmailProps>) => send(roleChanged, props.email, props);
