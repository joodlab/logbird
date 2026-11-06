import { fixtures, RoleChangedEmail } from '@logbird/email';

/** Sent to a member when someone else changes their role. */
export default function RoleChanged() {
  return <RoleChangedEmail {...fixtures.roleChanged} />;
}
