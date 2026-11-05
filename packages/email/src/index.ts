import nodemailer from 'nodemailer';
import type { ReactElement } from 'react';
import { createElement } from 'react';
import { render } from 'react-email';
import { env } from './env';
import { InvitationEmail, type InvitationEmailProps, invitationText } from './templates/invitation';
import { SignInCodeEmail } from './templates/sign-in-code';

export type { InvitationEmailProps } from './templates/invitation';

const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE === 'true',
  ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
});
async function send(to: string, subject: string, element: ReactElement, text?: string) {
  await transport.sendMail({
    from: env.MAIL_FROM,
    to,
    subject,
    html: await render(element),
    text: text ?? (await render(element, { plainText: true })),
  });
}

/** Render without sending (tests, previews). */
export const renderInvitation = async (props: InvitationEmailProps) => ({
  html: await render(createElement(InvitationEmail, props)),
  text: invitationText(props),
});

export const sendSignInCode = (to: string, code: string) => send(to, 'Your Trailmark sign-in code', createElement(SignInCodeEmail, { code }));

export const sendOrganizationInvitation = (props: InvitationEmailProps) =>
  send(
    props.email,
    `${props.inviterName} invited you to ${props.workspace} on Trailmark`,
    createElement(InvitationEmail, props),
    invitationText(props),
  );
