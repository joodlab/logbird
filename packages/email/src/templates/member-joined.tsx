// The server runs these through tsx with the classic JSX runtime, so React must be in scope.
import * as React from 'react';
import { formatDateTime, roleLabel, roleSummary, withArticle } from '../format';
import type { EmailDefinition } from '../render';
import { plainText } from '../text';
import { Button, DetailRows, EmailLayout, Note, Paragraph, Spacer, Strong, Title } from './components';

/** Sent to the inviter when someone accepts their invitation. */
export interface MemberJoinedEmailProps {
  appUrl: string;
  workspace: string;
  memberName: string;
  memberEmail: string;
  role: string;
  joinedAt: Date;
  /** Recipient: the person who sent the invitation. */
  inviterEmail: string;
}

const title = (p: MemberJoinedEmailProps) => `${p.memberName} joined ${p.workspace}`;
const lead = (p: MemberJoinedEmailProps) =>
  `${p.memberName} accepted your invitation and is now a member of ${p.workspace} as ${withArticle(roleLabel(p.role))}.`;
const details = (p: MemberJoinedEmailProps) => [
  { label: 'Member', value: p.memberName === p.memberEmail ? p.memberEmail : `${p.memberName} (${p.memberEmail})` },
  { label: 'Role', value: roleLabel(p.role), hint: roleSummary(p.role) },
  { label: 'Workspace', value: p.workspace },
  { label: 'Joined', value: formatDateTime(p.joinedAt) },
];
const reason = (p: MemberJoinedEmailProps) => `you invited ${p.memberEmail} to the ${p.workspace} workspace.`;
const NOTE_TITLE = 'Not who you expected?';
const note = (p: MemberJoinedEmailProps) => `An owner or admin can change their role or remove them from ${p.workspace} under Settings → Members.`;

export function MemberJoinedEmail(props: MemberJoinedEmailProps) {
  return (
    <EmailLayout appUrl={props.appUrl} preview={memberJoined.preview(props)} reason={reason(props)} title={title(props)}>
      <Title>{title(props)}</Title>
      <Paragraph>
        <Strong>{props.memberName}</Strong> accepted your invitation and is now a member of <Strong>{props.workspace}</Strong> as{' '}
        {withArticle(roleLabel(props.role))}.
      </Paragraph>
      <Spacer height={4} />
      <DetailRows rows={details(props)} />
      <Spacer height={24} />
      <Button href={props.appUrl}>Open Trailmark</Button>
      <Note title={NOTE_TITLE}>{note(props)}</Note>
    </EmailLayout>
  );
}

export const memberJoined: EmailDefinition<MemberJoinedEmailProps> = {
  id: 'member-joined',
  name: 'Member joined',
  recipient: 'inviterEmail',
  subject: (p) => `${p.memberName} joined ${p.workspace} on Trailmark`,
  preview: (p) => `${p.memberEmail} accepted your invitation and joined as ${roleLabel(p.role)}.`,
  text: (p) =>
    plainText({
      title: title(p),
      appUrl: p.appUrl,
      reason: reason(p),
      blocks: [lead(p), { details: details(p) }, { action: 'Open Trailmark', url: p.appUrl }, { title: NOTE_TITLE, note: note(p) }],
    }),
  Component: MemberJoinedEmail,
};
