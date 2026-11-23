import { homeContent } from '../home';
import { scopedReadLimitText } from '../scoped-read-limits';
import { SITE, type SiteState } from '../site';
import type { UseCase } from './types';

/**
 * /use-cases/customer-audit-logs. Brief, with the source of every claim: marketing/copy/use-cases/customer-audit-logs.md.
 * The page leads with reading through your own backend, and that limit comes before the how-to. Once scoped read access
 * is live (SiteState.scopedReadLive), a last section adds it, with the landing page's points and limit (one source).
 */
const event = `{
  "action": "booking.cancelled",
  "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad" },
  "tenant": { "id": "biz_7", "name": "Azure Hotels" },
  "targets": [{ "type": "booking", "id": "bk_1042" }]
}`;

const config = `// nuxt.config.ts. Set NUXT_LOGBIRD_INGEST_KEY and NUXT_LOGBIRD_READ_KEY on the server.
import { fileURLToPath } from 'node:url';

export default defineNuxtConfig({
  modules: ['@logbird/nuxt'],
  logbird: {
    endpoint: process.env.LOGBIRD_ENDPOINT,
    hooks: fileURLToPath(new URL('./server/logbird.ts', import.meta.url)),
  },
});`;

/** Exported so use-cases.test.ts can run the sample's authorize() against the real trailQuery. */
export const authorize = `// server/logbird.ts: runs on your server for every history request and next page.
import type { LogbirdHooks } from '@logbird/nuxt';
import { trailQuery } from '@logbird/sdk/read';

export default {
  authorize: async (event, query) => {
    const session = await getSession(event); // your own authentication
    const tenantId = session?.canViewHistory ? session.tenantId : undefined;
    // Denied, or no account to scope to: nothing is forwarded.
    if (typeof tenantId !== 'string' || !tenantId.trim()) return false;
    // Built from the user's account; the browser's filter is ignored.
    // trailQuery quotes the id for the query language.
    return trailQuery({
      tenant: tenantId,
      cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
    });
  },
} satisfies LogbirdHooks;`;

const component = `<!-- pages/account/history.vue: Nuxt auto-imports useAuditTrail; it reads through the route above. -->
<script setup lang="ts">
const { data, error, nextCursor, loadMore } = useAuditTrail({});
</script>

<template>
  <p v-if="error">The history couldn't be loaded.</p>
  <ol>
    <li v-for="item in data" :key="item.id">{{ item.timestamp }}: {{ item.description || item.action }}</li>
  </ol>
  <button v-if="nextCursor" type="button" @click="loadMore">Load more</button>
</template>`;

export function customerAuditLogsContent(site: SiteState): UseCase {
  const scoped = homeContent(site).customers.scoped;
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
        title: 'A project read key reads the whole project.',
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
            title: 'Nuxt: register your `authorize()` module',
            body: 'The `@logbird/nuxt` module adds a history route that refuses every request until your `authorize()` hook returns a query. Point `logbird.hooks` at the file that holds it.',
            code: { title: 'nuxt.config.ts', code: config, language: 'ts' },
          },
          {
            title: 'Build the query on the server',
            body: "Check the session, then build the query from the signed-in user's account. Only the query you return is forwarded, so a filter the browser sends can't widen it.",
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
            code: { title: 'pages/account/history.vue', code: component, language: 'text' },
          },
        ],
        visual: {
          id: 'tenant-summary',
          label: 'Customer account',
          caption:
            "Your team's view of one customer account in Logbird's console: its events in the last 24 hours and in all, and which support agents acted while signed in as the customer. Your customers see their own history in your product, rendered by your components. Select the image to open it full size.",
          zoom: true,
        },
      },
      ...(site.scopedReadLive
        ? [
            {
              id: 'scoped',
              eyebrow: 'Or let Logbird enforce it',
              title: 'Scoped keys and viewer tokens.',
              lead: 'Instead of building the query in your backend, give a scoped key or a viewer token one customer account. Logbird applies that scope to every read.',
              points: scoped.points,
              limit: { label: 'The limit', text: scopedReadLimitText },
            },
          ]
        : []),
    ],
  };
}

export const customerAuditLogs: UseCase = customerAuditLogsContent(SITE);
