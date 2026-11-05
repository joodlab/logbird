// The server runs these through tsx with the classic JSX runtime, so React must be in scope.
import * as React from 'react';
import { Button, Heading, Hr, Link, Section, Text } from 'react-email';
import { colors, EmailLayout, fonts } from './layout';

export interface InvitationEmailProps {
  /** Invited address. */
  email: string;
  workspace: string;
  inviterName: string;
  inviterEmail: string;
  role: string;
  url: string;
  expiresAt: Date;
}

export const ROLE_SUMMARY: Record<string, string> = {
  owner: 'Owners manage everything, including billing-level settings and other owners.',
  admin: 'Admins manage projects, API keys, retention and members.',
  member: 'Members can explore events, follow actors and records, and save views.',
};

export const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);

export function formatExpiry(date: Date) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(date).concat(' UTC');
}

export function InvitationEmail({ email, workspace, inviterName, inviterEmail, role, url, expiresAt }: InvitationEmailProps) {
  return (
    <EmailLayout
      footnote={`This invitation was sent to ${email}. If you were not expecting it, you can ignore this email — nothing happens until you accept.`}
      preview={`${inviterName} invited you to ${workspace} on Trailmark`}
    >
      <Heading style={{ fontSize: '22px', lineHeight: '30px', margin: '0 0 8px' }}>{`Join ${workspace} on Trailmark`}</Heading>
      <Text style={{ color: colors.muted, fontSize: '15px', lineHeight: '24px', margin: '0 0 20px' }}>
        <strong style={{ color: colors.text }}>{inviterName}</strong> ({inviterEmail}) invited you to the{' '}
        <strong style={{ color: colors.text }}>{workspace}</strong> workspace as {role === 'admin' || role === 'owner' ? 'an' : 'a'}{' '}
        <strong style={{ color: colors.text }}>{role}</strong>.
      </Text>
      <Section style={{ backgroundColor: colors.tint, border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '14px 16px' }}>
        <Text style={{ fontSize: '12px', color: colors.subtle, margin: 0, textTransform: 'uppercase', letterSpacing: '0.6px' }}>Your role</Text>
        <Text style={{ fontSize: '15px', fontWeight: 600, margin: '2px 0 2px' }}>{roleLabel(role)}</Text>
        <Text style={{ fontSize: '13px', lineHeight: '20px', color: colors.muted, margin: 0 }}>{ROLE_SUMMARY[role] ?? ROLE_SUMMARY.member}</Text>
      </Section>
      <Section style={{ margin: '24px 0 8px' }}>
        <Button
          href={url}
          style={{ backgroundColor: colors.brand, color: '#ffffff', fontSize: '14px', fontWeight: 600, padding: '12px 20px', borderRadius: '8px' }}
        >
          Accept invitation
        </Button>
      </Section>
      <Text style={{ fontSize: '13px', lineHeight: '20px', color: colors.subtle, margin: '12px 0 0' }}>
        This invitation expires on {formatExpiry(expiresAt)}. Sign in with {email} to accept it.
      </Text>
      <Hr style={{ borderColor: colors.border, margin: '24px 0 16px' }} />
      <Text style={{ fontSize: '12px', lineHeight: '18px', color: colors.subtle, margin: 0 }}>
        Button not working? Paste this link into your browser:
        <br />
        <Link href={url} style={{ color: colors.text, fontFamily: fonts.mono, fontSize: '12px', wordBreak: 'break-all' }}>
          {url}
        </Link>
      </Text>
    </EmailLayout>
  );
}

/** Hand-written plain-text part: readable in any client, no HTML-to-text artifacts. */
export function invitationText({ email, workspace, inviterName, inviterEmail, role, url, expiresAt }: InvitationEmailProps) {
  return [
    `Join ${workspace} on Trailmark`,
    '',
    `${inviterName} (${inviterEmail}) invited you to the ${workspace} workspace as ${role === 'admin' || role === 'owner' ? 'an' : 'a'} ${role}.`,
    ROLE_SUMMARY[role] ?? ROLE_SUMMARY.member,
    '',
    `Accept the invitation: ${url}`,
    '',
    `This invitation expires on ${formatExpiry(expiresAt)}. Sign in with ${email} to accept it.`,
    'If you were not expecting it, you can ignore this email — nothing happens until you accept.',
    '',
    '— Trailmark · A clear history of what happened.',
  ].join('\n');
}
