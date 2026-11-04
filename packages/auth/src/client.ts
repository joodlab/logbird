import { emailOTPClient, organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
export const createTrailmarkAuthClient = (options: { baseURL?: string } = {}) =>
  createAuthClient({
    ...options,
    basePath: '/api/auth',
    plugins: [emailOTPClient(), organizationClient()],
    fetchOptions: { credentials: 'include' },
  });
export const authClient = createTrailmarkAuthClient();
