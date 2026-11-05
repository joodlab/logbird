import { fixtures, MemberJoinedEmail } from '@trailmark/email';

/** Sent to the inviter when their invitation is accepted. */
export default function MemberJoined() {
  return <MemberJoinedEmail {...fixtures.memberJoined} />;
}
