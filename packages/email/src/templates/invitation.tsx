// The server runs these through tsx with the classic JSX runtime, so React must be in scope.
import * as React from 'react';
import { formatDateTime, formatRelative, roleLabel, roleSummary, withArticle } from '../format';
import type { EmailDefinition } from '../render';
import { plainText } from '../text';
import { Button, DetailRows, EmailLayout, Note, Paragraph, RawLink, Spacer, Strong, Title } from './components';

export interface InvitationEmailProps {
  appUrl: string;
  /** Invited address. */
  email: string;
  workspace: string;
  inviterName: string;
  inviterEmail: string;
  role: string;
  /** Accept page for this invitation. */
  url: string;
  expiresAt: Date;
  /** When the invitation was sent; drives "in 2 days". Defaults to now. */
  sentAt?: Date;
}

const inviter = (p: InvitationEmailProps) => (p.inviterName === p.inviterEmail ? p.inviterEmail : `${p.inviterName} (${p.inviterEmail})`);
const expiry = (p: InvitationEmailProps) => `${formatDateTime(p.expiresAt)} (${formatRelative(p.expiresAt, p.sentAt ?? new Date())})`;
const title = (p: InvitationEmailProps) => `Join ${p.workspace} on Trailmark`;
const lead = (p: InvitationEmailProps) =>
  `${inviter(p)} invited you to the ${p.workspace} workspace as ${withArticle(roleLabel(p.role))}. Trailmark keeps a searchable history of who did what, when and where across your team’s systems.`;

const details = (p: InvitationEmailProps) => [
  { label: 'Workspace', value: p.workspace },
  { label: 'Role', value: roleLabel(p.role), hint: roleSummary(p.role) },
  { label: 'Invited address', value: p.email },
  { label: 'Expires', value: expiry(p) },
];

const reason = (p: InvitationEmailProps) => `${p.inviterEmail} invited ${p.email} to the ${p.workspace} workspace.`;
const NOTE_TITLE = 'Not expecting this?';
const note = (p: InvitationEmailProps) =>
  `You can ignore it — you won’t join ${p.workspace} unless you accept. To accept, sign in as ${p.email}; the invitation only works for that address.`;

export function InvitationEmail(props: InvitationEmailProps) {
  return (
    <EmailLayout appUrl={props.appUrl} preview={invitation.preview(props)} reason={reason(props)} title={title(props)}>
      <Title>{title(props)}</Title>
      <Paragraph>
        <Strong>{props.inviterName}</Strong>
        {props.inviterName === props.inviterEmail ? null : ` (${props.inviterEmail})`} invited you to the <Strong>{props.workspace}</Strong> workspace
        as {withArticle(roleLabel(props.role))}. Trailmark keeps a searchable history of who did what, when and where across your team’s systems.
      </Paragraph>
      <Spacer height={4} />
      <DetailRows rows={details(props)} />
      <Spacer height={24} />
      <Button href={props.url}>Accept invitation</Button>
      <RawLink href={props.url} />
      <Note title={NOTE_TITLE}>{note(props)}</Note>
    </EmailLayout>
  );
}

export const invitation: EmailDefinition<InvitationEmailProps> = {
  id: 'invitation',
  subject: (p) => `${p.inviterName} invited you to ${p.workspace} on Trailmark`,
  preview: (p) => `Join as ${roleLabel(p.role)}. The invitation expires ${formatRelative(p.expiresAt, p.sentAt ?? new Date())}.`,
  text: (p) =>
    plainText({
      title: title(p),
      appUrl: p.appUrl,
      reason: reason(p),
      blocks: [lead(p), { details: details(p) }, { action: 'Accept the invitation', url: p.url }, { title: NOTE_TITLE, note: note(p) }],
    }),
  Component: InvitationEmail,
};
