import { routes, sessionActionResponseSchema } from '@logbird/contracts';
import { emailOTPClient, organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { withDeadline } from '@/lib/api/errors';

/**
 * better-auth client. Same origin as the console: `/api/auth/*` is proxied to the Hono server
 * (vite dev proxy / Nitro route rules), so the session cookie is first-party.
 */
export const authClient = createAuthClient({
  baseURL: typeof window === 'undefined' ? 'http://localhost:4600' : window.location.origin,
  basePath: '/api/auth',
  // Abort auth calls a starved server never answers; callers race a shorter deadline (AUTH_DEADLINE_MS) for the message.
  fetchOptions: { timeout: 20_000 },
  plugins: [emailOTPClient(), organizationClient()],
});

/** How long sign-in steps (send code, verify) wait before offering a retry. */
export const AUTH_DEADLINE_MS = 15_000;

/** Logbird commits deletion and session-end evidence together before clearing the cookie. */
export async function signOut() {
  const response = await fetch(routes.sessions.signOut.path, { method: 'POST', credentials: 'include', signal: AbortSignal.timeout(20_000) });
  if (!response.ok && response.status !== 401) throw new Error('Sign-out failed. Retry shortly.');
  if (response.ok) sessionActionResponseSchema.parse(await response.json());
  authClient.$store.notify('$sessionSignal');
}

/** Unwrap better-auth's `{ data, error }` result into a value or a thrown Error. */
export async function authCall<T>(
  promise: Promise<{ data: T | null; error: { message?: string; status?: number; code?: string } | null }>,
): Promise<T> {
  const { data, error } = await promise;
  if (error) {
    const err = new Error(error.message || 'Authentication request failed.') as Error & { status?: number; code?: string };
    err.status = error.status;
    err.code = error.code;
    throw err;
  }
  return data as T;
}

/** Email a sign-in code. Bounded: a server that never answers becomes an error the form can retry. */
export function sendSignInCode(email: string) {
  return withDeadline(authCall(authClient.emailOtp.sendVerificationOtp({ email, type: 'sign-in' })), AUTH_DEADLINE_MS, 'The Logbird server');
}

/** Exchange a sign-in code for a session, bounded like `sendSignInCode`. */
export function verifySignInCode(email: string, otp: string) {
  return withDeadline(authCall(authClient.signIn.emailOtp({ email, otp })), AUTH_DEADLINE_MS, 'The Logbird server');
}
