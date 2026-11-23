import { isRawJson } from '@logbird/contracts';

export const OCCURRED_AT_PAST_DAYS = 3650;
export const OCCURRED_AT_FUTURE_DAYS = 1;

/** Receipt-relative resolution is identity policy; keep it independent of input admission and search caps. */
export function resolveTimestamp(input: unknown, receivedAt: Date) {
  // Epoch milliseconds with digits beyond a double (sub-millisecond fractions) resolve exactly as JSON.parse did.
  const value = isRawJson(input) ? Number(input.rawJSON) : input;
  const supplied = value !== undefined && value !== null && value !== '';
  let problem: string | null = null;
  if (supplied) {
    if (typeof value !== 'string' && typeof value !== 'number') problem = 'occurredAt must be ISO-8601 or epoch milliseconds';
    else if (typeof value === 'number' && Math.abs(value) < 1e11) problem = 'occurredAt looks like epoch seconds; send milliseconds or ISO-8601';
    else {
      const time = new Date(value).getTime();
      if (!Number.isFinite(time)) problem = 'occurredAt is not a valid date';
      else if (time < receivedAt.getTime() - OCCURRED_AT_PAST_DAYS * 86_400_000 || time > receivedAt.getTime() + OCCURRED_AT_FUTURE_DAYS * 86_400_000)
        problem = 'occurredAt must be within the last 3650 days and the next 24 hours';
    }
  }
  return { timestamp: supplied && !problem ? new Date(value as string | number) : receivedAt, problem, valid: supplied && !problem };
}
