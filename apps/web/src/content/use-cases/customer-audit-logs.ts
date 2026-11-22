import { SITE, type SiteState } from '../site';
import type { UseCase } from './types';

/**
 * /use-cases/customer-audit-logs. Brief, with the source of every claim: marketing/copy/use-cases/customer-audit-logs.md.
 * Scoped read keys and viewer tokens are not described here until the maintainer confirms their production proof
 * (SiteState.scopedReadLive); today the page describes reading through your own backend, and its limit comes before
 * the how-to.
 */
const event = `{
  "action": "booking.cancelled",
  "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad" },
  "tenant": { "id": "biz_7", "name": "Azure Hotels" },
  "targets": [{ "type": "booking", "id": "bk_1042" }]
}`;

const authorize = `// server/logbird.ts: Nuxt runs this on your server for every history request.
export default {
  authorize: async (event, query) => {
    const session = await getSession(event); // your own authentication
    if (!session) return false; // denied: nothing is forwarded to Logbird
    // Only the query you return is forwarded: one customer account.
    return { ...query, q: \`tenant:"\${session.tenantId}"\` };
  },
};`;

const component = `<script setup lang="ts">
// Nuxt auto-imports useAuditTrail; it reads through the authorized route above.
const trail = useAuditTrail({ target: { type: 'booking', id: props.bookingId } });
</script>`;

export function customerAuditLogsContent(_site: SiteState): UseCase {
  return {
    meta: {
      title: 'Customer-facing audit logs',
      description:
        'Show each customer account its own history, inside your product and through your own backend: send the account with each event, authorize every read, render it with your components.',
    },
    hero: {
      eyebrow: 'Use case · Customer-facing audit logs',
      title: 'Show each customer their own history.',
      lead: "Your customers' admins want to see who did what in their account. With Logbird, they see it inside your product, through your own backend, which decides what each user may read.",
    },
    sections: [
      {
        id: 'send',
        eyebrow: 'Step one',
        title: 'Send the customer account with every event.',
        lead: 'Each event names the account it belongs to in `tenant`. That is what lets your product show every account its own trail later.',
        steps: [
          {
            title: 'Add `tenant` to each event',
            body: 'With the actor and the records it touched. Only `action` is required, but an event without `tenant` belongs to no account.',
            code: { title: 'An event', code: event, language: 'json' },
          },
        ],
        limit: {
          label: 'The limit',
          text: "Logbird records what your code sends. It can't work out later which account an event without `tenant` belonged to.",
        },
      },
      {
        id: 'before',
        eyebrow: 'Before you build the view',
        title: 'A read key reads the whole project.',
        lead: 'A query filter is not authorization. Your backend must check which customer account, and which records, the signed-in user may see, on every request, including each next page.',
        points: [
          { title: 'Keys stay on your server', body: 'Never put an ingest or read key in a browser bundle or public configuration.' },
          {
            title: 'The browser asks your backend',
            body: 'Your backend authenticates the request, decides the account, builds the query itself and only then reads from Logbird.',
          },
          { title: 'Never trust the browser’s filter', body: 'A tenant or query the browser sends is a request, not a permission.' },
        ],
      },
      {
        id: 'read',
        eyebrow: 'Step two',
        title: 'Authorize every read in one place.',
        steps: [
          {
            title: 'Nuxt: the history route denies by default',
            body: 'The `@logbird/nuxt` module adds a history route that refuses every request until your `authorize()` hook returns a query. Only that query is forwarded.',
            code: { title: 'server/logbird.ts', code: authorize, language: 'ts' },
          },
          {
            title: 'TanStack Start or any backend',
            body: 'Call `readAuditTrail` with a query built by `trailQuery` in a server function, or call the read API from your backend with the read key, after the same check.',
          },
        ],
      },
      {
        id: 'render',
        eyebrow: 'Step three',
        title: 'Render it with your own components.',
        steps: [
          {
            title: 'Vue: `useAuditTrail`',
            body: 'It loads the events page by page, with loading, error, refresh and load-more states, and discards a stale response. The headless `AuditTimeline` passes the same state to your markup.',
            code: { title: 'A Vue component in Nuxt', code: component, language: 'ts' },
          },
        ],
        visual: {
          id: 'tenant-account',
          label: 'Customer account',
          caption:
            "Your team's view of one customer account in Logbird's console: its events in the last 24 hours and in all, and which support agents acted while signed in as the customer. Your customers see their own history in your product, rendered by your components. Select the image to open it full size.",
          zoom: true,
        },
      },
    ],
  };
}

export const customerAuditLogs: UseCase = customerAuditLogsContent(SITE);
