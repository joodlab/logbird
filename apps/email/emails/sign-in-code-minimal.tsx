import { fixtures, SignInCodeEmail } from '@trailmark/email';

/** Sign-in code without request hints (no User-Agent / X-Forwarded-For, e.g. local dev): those rows are omitted. */
export default function SignInCodeMinimal() {
  const { userAgent: _userAgent, ip: _ip, ...props } = fixtures.signInCode;
  return <SignInCodeEmail {...props} />;
}
