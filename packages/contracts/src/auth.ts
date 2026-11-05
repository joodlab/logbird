/**
 * How long an emailed sign-in code stays valid, in seconds. The single source for the auth server's emailOTP
 * `expiresIn`, the sign-in email copy and the console's verify page.
 */
export const SIGN_IN_CODE_TTL_SECONDS = 600;

/** "10 minutes" for copy that states the sign-in code lifetime. */
export function signInCodeLifetimeLabel(seconds = SIGN_IN_CODE_TTL_SECONDS): string {
  const minutes = Math.round(seconds / 60);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
