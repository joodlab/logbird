/** Receipt-relative resolution is identity policy; keep it independent of input admission and search caps. */
export function resolveTimestamp(value: unknown, receivedAt: Date) {
  const supplied = value !== undefined && value !== null && value !== '';
  let problem: string | null = null;
  if (supplied) {
    if (typeof value !== 'string' && typeof value !== 'number') problem = 'occurredAt must be ISO-8601 or epoch milliseconds';
    else if (typeof value === 'number' && Math.abs(value) < 1e11) problem = 'occurredAt looks like epoch seconds; send milliseconds or ISO-8601';
    else {
      const time = new Date(value).getTime();
      if (!Number.isFinite(time)) problem = 'occurredAt is not a valid date';
      else if (time < receivedAt.getTime() - 3650 * 86_400_000 || time > receivedAt.getTime() + 86_400_000)
        problem = 'occurredAt must be within the last 3650 days and the next 24 hours';
    }
  }
  return { timestamp: supplied && !problem ? new Date(value as string | number) : receivedAt, problem, valid: supplied && !problem };
}
