import { requestRateLimit } from './rate-limit';

export function inviteRateLimit(limit = 30, windowMs = 60_000) {
  return requestRateLimit('invite', limit, windowMs);
}
export const limitInviteRequests = inviteRateLimit();
