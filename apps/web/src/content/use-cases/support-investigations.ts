import { SITE, type SiteState } from '../site';
import type { UseCase } from './types';

/**
 * /use-cases/support-investigations. Brief, with the source of every claim: marketing/copy/use-cases/support-investigations.md.
 * The third paid job's companion: support and operations answering "what happened?" for one account or record.
 */
const queries = `# One account's failures
tenant:biz_7 outcome:failure

# One booking's history
record:booking:bk_1042

# Done by support
impersonator:*

# Bookings, last 7 days
action:booking.* occurredAt:>now-7d`;

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
      lead: 'When a customer asks why a booking changed or who removed a user, support and operations open the account or the record and read its events in order: who acted, what did the work, and the before and after values your code sends.',
    },
    sections: [
      {
        id: 'find',
        eyebrow: 'Start from what the customer names',
        title: 'Open the account or the record.',
        points: [
          {
            title: 'Jump to (Ctrl K)',
            body: 'Type an id or a name. An exact id leads the list, and a record is found by its bare id, such as `bk_1042` for `booking:bk_1042`.',
          },
          {
            title: 'Entity pages',
            body: 'Each customer account, actor, executor and record has its own page with a timeline of every event that mentions it.',
          },
          {
            title: 'Done by support',
            body: "A customer account's page separates what support did while signed in as the customer from everything else, and names the support agents.",
          },
        ],
        limit: {
          label: 'The limit',
          text: 'A page shows the events your code sent with that account or record. An event sent without `tenant` or `targets` is not on it.',
        },
      },
      {
        id: 'search',
        eyebrow: 'Search',
        title: 'Narrow it down in one search.',
        steps: [
          {
            title: 'Type what you know',
            body: 'The query language matches fields exactly, with prefixes, ranges and `OR`. The search bar suggests fields and values with how many events have each. A guarded SQL `WHERE` expression is there when you need it.',
            code: { title: 'Examples', code: queries, language: 'text' },
          },
        ],
        limit: {
          label: 'The limit',
          text: 'A search covers the time range you pick. When nothing matches there but older events do, the explorer offers to search all time. When counting is cut short, the total is a lower bound, shown as "≥ N" or "10,000+".',
        },
        visual: {
          id: 'explorer',
          label: 'Explorer',
          caption:
            'The explorer filtered to booking actions: a histogram of the last seven days, facets for outcome, support, severity and action, and the matching events.',
          zoom: true,
        },
      },
      {
        id: 'event',
        eyebrow: 'One event',
        title: 'Read who asked, what did the work, and what changed.',
        points: [
          { title: 'Actor and executor', body: 'Who asked for the action, and the API or worker that performed it, with the attempt number.' },
          { title: 'Impersonator', body: 'When support acted for a customer, the staff member who did.' },
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
            body: 'The events that share an operation id, the request and every job it started, each linked to the event that caused it.',
          },
          {
            title: 'Retries in place',
            body: 'A retried job shows each attempt on the same executor, so a failure and the retry that fixed it sit side by side.',
          },
        ],
        limit: {
          label: 'The limit',
          text: 'The tree is as complete as the ids your code passes on: a job joins the operation only when you pass its operation id and parent event into the job.',
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
                "No. It holds only the events your code sent. You can import older history by sending events with their original time; the project's retention still applies.",
            },
          ],
        },
        cta: { label: 'Take the product tour', to: '/product' },
      },
    ],
  };
}

export const supportInvestigations: UseCase = supportInvestigationsContent(SITE);
