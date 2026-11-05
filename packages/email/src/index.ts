/**
 * @trailmark/email — Trailmark's transactional email templates.
 *
 * This entry is side-effect free (no env, no SMTP): render any email anywhere — the server, the preview app in
 * `apps/email`, tests. Sending lives in `@trailmark/email/send`.
 */
import { invitation } from './templates/invitation';
import { memberJoined } from './templates/member-joined';
import { roleChanged } from './templates/role-changed';
import { signInCode } from './templates/sign-in-code';

export type { EmailFixtures } from './fixtures';
export { createFixtures, fixtures } from './fixtures';
export { clientIp, describeUserAgent, primaryRole } from './format';
export type { EmailDefinition, RenderedEmail } from './render';
export { renderEmail } from './render';
export { InvitationEmail, type InvitationEmailProps, invitation } from './templates/invitation';
export { MemberJoinedEmail, type MemberJoinedEmailProps, memberJoined } from './templates/member-joined';
export { RoleChangedEmail, type RoleChangedEmailProps, roleChanged } from './templates/role-changed';
export { type OtpPurpose, SignInCodeEmail, type SignInCodeEmailProps, signInCode } from './templates/sign-in-code';

/** Every email Trailmark sends, keyed like `fixtures`. Tests, previews and the send command iterate over this. */
export const emails = { signInCode, invitation, memberJoined, roleChanged } as const;
export type EmailKey = keyof typeof emails;
