// The server runs these through tsx with the classic JSX runtime, so React must be in scope.
import * as React from 'react';
import { formatDateTime, roleLabel, roleSummary } from '../format';
import type { EmailDefinition } from '../render';
import { plainText } from '../text';
import { Button, DetailRows, EmailLayout, Note, Paragraph, Spacer, Strong, Title } from './components';

/** Sent to a member when someone else changes their role. */
export interface RoleChangedEmailProps {
  appUrl: string;
  /** Recipient: the member whose role changed. */
  email: string;
  workspace: string;
  previousRole: string;
  role: string;
  changedByName: string;
  changedByEmail: string;
  changedAt: Date;
}

const title = (p: RoleChangedEmailProps) => `Your role in ${p.workspace} changed`;
const actor = (p: RoleChangedEmailProps) => (p.changedByName === p.changedByEmail ? p.changedByEmail : `${p.changedByName} (${p.changedByEmail})`);
const lead = (p: RoleChangedEmailProps) => `${actor(p)} changed your role from ${roleLabel(p.previousRole)} to ${roleLabel(p.role)}.`;
const details = (p: RoleChangedEmailProps) => [
  { label: 'New role', value: roleLabel(p.role), hint: roleSummary(p.role) },
  { label: 'Previous role', value: roleLabel(p.previousRole) },
  { label: 'Workspace', value: p.workspace },
  { label: 'Changed by', value: actor(p) },
  { label: 'When', value: formatDateTime(p.changedAt) },
];
const reason = (p: RoleChangedEmailProps) => `you’re a member of the ${p.workspace} workspace (${p.email}).`;
const NOTE_TITLE = 'Didn’t expect this?';
const NOTE = 'Ask a workspace owner. Every role change is recorded in the workspace activity log.';

export function RoleChangedEmail(props: RoleChangedEmailProps) {
  return (
    <EmailLayout appUrl={props.appUrl} preview={roleChanged.preview(props)} reason={reason(props)} title={title(props)}>
      <Title>{title(props)}</Title>
      <Paragraph>
        <Strong>{props.changedByName}</Strong> changed your role from <Strong>{roleLabel(props.previousRole)}</Strong> to{' '}
        <Strong>{roleLabel(props.role)}</Strong>.
      </Paragraph>
      <Spacer height={4} />
      <DetailRows rows={details(props)} />
      <Spacer height={24} />
      <Button href={props.appUrl}>Open Trailmark</Button>
      <Note title={NOTE_TITLE}>{NOTE}</Note>
    </EmailLayout>
  );
}

export const roleChanged: EmailDefinition<RoleChangedEmailProps> = {
  id: 'role-changed',
  subject: (p) => `Your role in ${p.workspace} is now ${roleLabel(p.role)}`,
  preview: (p) => `${p.changedByName} changed your role from ${roleLabel(p.previousRole)} to ${roleLabel(p.role)}.`,
  text: (p) =>
    plainText({
      title: title(p),
      appUrl: p.appUrl,
      reason: reason(p),
      blocks: [lead(p), { details: details(p) }, { action: 'Open Trailmark', url: p.appUrl }, { title: NOTE_TITLE, note: NOTE }],
    }),
  Component: RoleChangedEmail,
};
