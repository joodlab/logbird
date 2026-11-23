import { SITE, type SiteState } from '../site';
import type { UseCase } from './types';

/**
 * /use-cases/support-investigations. Brief, with the source of every claim: marketing/copy/use-cases/support-investigations.md.
 * The third paid job's companion: support and operations answering "what happened?" for one account or record.
 * Each example query is one inline code span with no copy button, so what a reader copies is the query alone; the
 * test compiles each one exactly as shown.
 */
export function supportInvestigationsContent(_site: SiteState): UseCase {
  return {
    meta: {
      title: 'Support investigations',
      description:
        'Answer "what happened in this account?": open the account or the record, search its events, read who acted and what changed, and follow one operation from the request to its jobs.',
    },
    hero: {
      eyebrow: 'Use case · Support investigations',
      title: 'Answer "what happened in this account?"',
      lead: 'When a customer asks why a booking changed or who removed a user, support and operations open the account or the record and read its events in order: who acted, what ran it, and the before and after values your code sends.',
    },
    sections: [
      {
        id: 'find',
        eyebrow: 'Start from what the customer names',
        title: 'Open the account or the record.',
        points: [
          {
            title: 'Jump to (Ctrl K)',
            body: 'Type a name to see matching entities, or an exact id to highlight it. For a record, its bare id is enough, such as `bk_1042` for `booking:bk_1042`.',
          },
          {
            title: 'Entity pages',
            body: 'Each customer account, actor, executor and record has its own page with a timeline of every event that mentions it.',
          },
          {
            title: 'Done by support',
            body: "When events name a support agent (`impersonator`), a customer account's page shows how many were done by support and lists up to six agents, by name or id.",
          },
        ],
        limit: {
          label: 'The limit',
          text: "An account's page lists the events whose `tenant` id matches; a record's page lists the events that name it in `targets`. An event sent without them is on neither page, though search still finds it.",
        },
      },
      {
        id: 'search',
        eyebrow: 'Search',
        title: 'Narrow it down in one search.',
        lead: 'The query language matches fields exactly, with prefixes, ranges and `OR`. The search bar suggests fields and values as you type, some values with counts from the events it checked. A guarded SQL `WHERE` expression is there when you need it.',
        points: [
          { title: "One account's failures", body: '`tenant:biz_7 outcome:failure`' },
          { title: "One booking's history", body: '`record:booking:bk_1042`' },
          { title: 'Done by support', body: '`impersonator:*`' },
          { title: 'Bookings, last 7 days', body: '`action:booking.* occurredAt:>now-7d`' },
        ],
        limit: {
          label: 'The limit',
          text: 'A search covers the time range you pick. When nothing matches, the explorer offers the id query if you typed a bare id that matches an entity; otherwise, when it finds matches outside your range, it offers to search all time. When counting is cut short, the total is a lower bound, shown as "≥ N" or "10,000+".',
        },
        visual: {
          id: 'explorer',
          label: 'Explorer',
          caption: 'Booking actions over the last seven days, with the matching events below the chart.',
          zoom: true,
        },
      },
      {
        id: 'event',
        eyebrow: 'One event',
        title: 'Read who acted, what ran it, and what changed.',
        points: [
          {
            title: 'Actor and impersonator',
            body: 'The actor is the identity the action used. When support acted for a customer, the customer stays the actor and the staff member is the impersonator.',
          },
          { title: 'Executor', body: 'The API or worker that ran it, with the attempt number when your code sends it.' },
          { title: 'Changes', body: 'The before and after values your code sends, the first 256 per event.' },
          { title: 'Copy link', body: 'Share the event with a colleague who has access to the project.' },
        ],
        limit: { label: 'The limit', text: "Logbird records what your code sends. It can't add an actor or a change that your event leaves out." },
        visual: {
          id: 'event-detail',
          label: 'Event detail',
          caption:
            'One event in the console: who caused it and what performed it, the customer account, the records it touched, the before and after value, and what caused it.',
          zoom: true,
        },
      },
      {
        id: 'operation',
        eyebrow: 'Operations',
        title: 'Follow one operation from the request to its jobs.',
        points: [
          {
            title: 'One tree',
            body: 'The events that share an operation id: the request and the jobs it started. An event that names its parent sits under the event that caused it.',
          },
          {
            title: 'Retries',
            body: 'Send the same operation id on each attempt, with its attempt number and outcome, to see which try succeeded.',
          },
        ],
        limit: {
          label: 'The limit',
          text: 'The tree holds only the events that carry its operation id: pass it into each job yourself, and the parent event to place a job under its cause.',
        },
      },
      {
        id: 'not',
        eyebrow: "What Logbird doesn't do",
        title: 'Know these before a customer asks.',
        limits: {
          questions: true,
          headers: { promise: 'Question', limit: 'Answer' },
          rows: [
            {
              promise: 'Does Logbird record who searched for or opened an event?',
              limit: 'No. Workspace activity records changes to projects, keys and members, exports and sign-ins, but not reads.',
            },
            {
              promise: 'Does free text search the whole event?',
              limit:
                'No. Free text searches the description and the actor, account and record names. Search other fields by name, such as `metadata.channel:whatsapp`.',
            },
            {
              promise: 'Can Logbird show what happened before you started sending events?',
              limit:
                "No. It holds only the events your code sent. If you already have older events, send them with their original time, up to 3,650 days back; an older time is stored as the time Logbird received it. The project's retention still applies.",
            },
          ],
        },
        cta: { label: 'Take the product tour', to: '/product' },
      },
    ],
  };
}

export const supportInvestigations: UseCase = supportInvestigationsContent(SITE);
