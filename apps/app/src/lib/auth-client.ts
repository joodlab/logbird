import { emailOTPClient, organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { transportFetch } from '@/lib/api/transport';

/**
 * better-auth client. Same origin as the console: `/api/auth/*` is proxied to the Hono server
 * (vite dev proxy / Nitro route rules), so the session cookie is first-party. The fetch goes
 * through the shared transport so fixture mode can answer auth calls too.
 */
export const authClient = createAuthClient({
  baseURL: typeof window === 'undefined' ? 'http://localhost:4600' : window.location.origin,
  basePath: '/api/auth',
  plugins: [emailOTPClient(), organizationClient()],
  fetchOptions: { customFetchImpl: transportFetch },
});

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
