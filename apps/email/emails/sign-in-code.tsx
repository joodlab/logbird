import { fixtures, SignInCodeEmail } from '@trailmark/email';

/** Sign-in code as it arrives behind a reverse proxy: device and IP rows filled in. */
export default function SignInCode() {
  return <SignInCodeEmail {...fixtures.signInCode} />;
}
