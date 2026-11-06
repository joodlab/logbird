import { fixtures, MemberJoinedEmail } from '@logbird/email';

/** Sent to the inviter when their invitation is accepted. */
export default function MemberJoined() {
  return <MemberJoinedEmail {...fixtures.memberJoined} />;
}
