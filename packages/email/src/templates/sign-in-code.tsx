// The server runs these through tsx with the classic JSX runtime, so React must be in scope.
import * as React from 'react';
import { describeUserAgent, formatDateTime, formatTime, hostOf } from '../format';
import type { EmailDefinition } from '../render';
import { plainText } from '../text';
import { CodeBlock, type Detail, DetailRows, EmailLayout, Note, Paragraph, Spacer, Strong, Title } from './components';

export type OtpPurpose = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';

export interface SignInCodeEmailProps {
  appUrl: string;
  /** Address the code was sent to. */
  email: string;
  code: string;
  /** better-auth's OTP type; Trailmark only signs in with codes, the rest share the "verification" wording. */
  purpose?: OtpPurpose;
  expiresInMinutes: number;
  requestedAt: Date;
  /** Raw User-Agent of the request, shown as "Chrome on Windows". */
  userAgent?: string;
  ip?: string;
}

const copy = (purpose: OtpPurpose = 'sign-in') =>
  purpose === 'sign-in'
    ? { noun: 'sign-in code', title: 'Your sign-in code', action: 'sign in', lead: 'Enter this code on the Trailmark sign-in page to continue as' }
    : { noun: 'verification code', title: 'Your verification code', action: 'verify this address', lead: 'Enter this code in Trailmark to verify' };

const expiresAt = (p: SignInCodeEmailProps) => new Date(p.requestedAt.getTime() + p.expiresInMinutes * 60_000);
const caption = (p: SignInCodeEmailProps) => `Expires in ${p.expiresInMinutes} minutes, at ${formatTime(expiresAt(p))}`;

function details(p: SignInCodeEmailProps) {
  const device = describeUserAgent(p.userAgent);
  return [
    { label: 'Account', value: p.email },
    { label: 'Requested', value: formatDateTime(p.requestedAt) },
    ...(device ? [{ label: 'Device', value: device }] : []),
    ...(p.ip ? [{ label: 'IP address', value: p.ip, mono: true }] : []),
  ] satisfies Detail[];
}

const reason = (p: SignInCodeEmailProps) => `a ${copy(p.purpose).noun} was requested for ${p.email} on ${hostOf(p.appUrl)}.`;
const NOTE_TITLE = 'Didn’t request this?';
const note = (p: SignInCodeEmailProps) =>
  `You can ignore this email — nobody can ${copy(p.purpose).action} without this code. Never share it: Trailmark will never ask you for it.`;

export function SignInCodeEmail(props: SignInCodeEmailProps) {
  const c = copy(props.purpose);
  return (
    <EmailLayout appUrl={props.appUrl} preview={signInCode.preview(props)} reason={reason(props)} title={c.title}>
      <Title>{c.title}</Title>
      <Paragraph>
        {c.lead} <Strong>{props.email}</Strong>.
      </Paragraph>
      <Spacer height={4} />
      <CodeBlock caption={caption(props)} code={props.code} />
      <Spacer height={20} />
      <DetailRows rows={details(props)} />
      <Note title={NOTE_TITLE}>{note(props)}</Note>
    </EmailLayout>
  );
}

export const signInCode: EmailDefinition<SignInCodeEmailProps> = {
  id: 'sign-in-code',
  name: 'Sign-in code',
  recipient: 'email',
  // The code leads so it is readable straight from the notification.
  subject: (p) => `${p.code} is your Trailmark ${copy(p.purpose).noun}`,
  preview: (p) => {
    const device = describeUserAgent(p.userAgent);
    const from = [device, p.ip].filter(Boolean).join(', ');
    return `Expires in ${p.expiresInMinutes} minutes. Requested ${from ? `from ${from}` : formatDateTime(p.requestedAt)}.`;
  },
  text: (p) =>
    plainText({
      title: copy(p.purpose).title,
      appUrl: p.appUrl,
      reason: reason(p),
      blocks: [
        `${copy(p.purpose).lead} ${p.email}.`,
        { code: p.code, caption: caption(p) },
        { details: details(p) },
        { title: NOTE_TITLE, note: note(p) },
      ],
    }),
  Component: SignInCodeEmail,
};
