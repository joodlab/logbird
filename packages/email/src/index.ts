import nodemailer from 'nodemailer';
import { createElement } from 'react';
import { render } from 'react-email';
import { env } from './env';
import { Message } from './templates/message';

const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE === 'true',
  ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
});
async function send(to: string, subject: string, props: Parameters<typeof Message>[0]) {
  const element = createElement(Message, props);
  await transport.sendMail({ from: env.MAIL_FROM, to, subject, html: await render(element), text: await render(element, { plainText: true }) });
}
export const sendSignInCode = (to: string, code: string) => send(to, 'Your Trailmark sign-in code', { code });
export const sendOrganizationInvitation = (to: string, organization: string, url: string) =>
  send(to, `Join ${organization} on Trailmark`, { organization, url });
