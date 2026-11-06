import { fixtures, InvitationEmail } from '@logbird/email';

export default function Invitation() {
  return <InvitationEmail {...fixtures.invitation} />;
}
