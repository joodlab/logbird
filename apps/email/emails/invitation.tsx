import { fixtures, InvitationEmail } from '@trailmark/email';

export default function Invitation() {
  return <InvitationEmail {...fixtures.invitation} />;
}
