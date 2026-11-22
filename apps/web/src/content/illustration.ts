/**
 * The brand illustration from the mark and the social card (components/marketing/log-stack.tsx): a stack of log entries
 * where the newest one is indigo. It is an illustration, not a screenshot: fictional events from docs/concepts.md, no
 * counts or timings.
 */
export const logStackRows: {
  action: string;
  who: string;
  what: string;
  when: string;
  outcome: 'success' | 'failure' | 'denied';
}[] = [
  { action: 'payment.refunded', who: 'Refunds worker · attempt 2', what: 'Booking #1042', when: 'now', outcome: 'success' },
  { action: 'payment.refund_failed', who: 'Refunds worker · attempt 1', what: 'Booking #1042', when: '14:32:12', outcome: 'failure' },
  { action: 'booking.cancelled', who: 'Lina Haddad', what: 'Booking #1042', when: '14:32:10', outcome: 'success' },
  { action: 'room.rate.updated', who: 'Omar Saleh via support', what: 'Room 12', when: '14:18:47', outcome: 'success' },
  { action: 'api_key.revoked', who: 'Yara Nasser', what: 'Ingest key', when: '13:05:02', outcome: 'denied' },
];
