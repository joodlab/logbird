import { SITE, type SiteState } from '../site';
import type { UseCase } from './types';

/**
 * /use-cases/compliance-evidence. Brief, with the source of every claim: marketing/copy/use-cases/compliance-evidence.md.
 * No integrity, tamper, proof or certified wording near the export digest (maintainer rule).
 */
const file = 'logbird-events-<export-id>-evidence.jsonl';

export function complianceEvidenceContent(_site: SiteState): UseCase {
  return {
    meta: {
      title: 'Compliance evidence',
      description:
        'Answer an auditor with the events: who acted, for whom, on which records and what changed, an export you can match to its record, and the limits stated plainly.',
    },
    hero: {
      eyebrow: 'Use case · Compliance evidence',
      title: 'Answer the auditor with evidence.',
      lead: "When an auditor or a customer's security team asks what happened, show them the events, and hand them an export they can match to Logbird's record of it.",
    },
    sections: [
      {
        id: 'event',
        eyebrow: 'What an event can show',
        title: 'Who acted, for whom, on which records, and what changed.',
        lead: 'Each field is optional except `action`. The more your code sends, the more an auditor can see.',
        points: [
          { title: 'Actor', body: 'Who caused the action: a person, a service or a scheduled job, with its id and name.' },
          { title: 'Impersonator', body: 'When support acts for a customer, the staff member who acted for whom (`impersonator`).' },
          { title: 'Executor', body: 'What performed it, such as the API or a worker, and on which attempt.' },
          { title: 'Customer account', body: 'The tenant the event belongs to, so each account has its own history.' },
          { title: 'Records', body: 'Each record the action touched, by type and id.' },
          {
            title: 'Changes',
            body: "The before and after values your code sends. Logbird keeps up to 256 changes per event in the event's change fields, which the console shows; the evidence export also carries the original JSON Logbird stored for the event.",
          },
        ],
        limit: { label: 'The limit', text: "Logbird records what your code sends. It can't add an actor or a change that your event leaves out." },
        visual: {
          id: 'event-detail',
          label: 'Event detail',
          caption:
            'One event in the console: who caused it and what performed it, the customer account, the records it touched, the before and after value, and what caused it.',
        },
      },
      {
        id: 'retention',
        eyebrow: 'Retention',
        title: 'Keep events as long as you need, then they are gone.',
        points: [
          { title: 'Per project', body: 'Choose a window from 7 days to 10 years. New projects start at 90 days.' },
          { title: 'Hourly deletion', body: 'A worker deletes events older than the window every hour. Each run is recorded and shown in Settings.' },
          {
            title: 'Lowering it',
            body: "Logbird shows roughly how many events will be deleted, and you confirm by typing the project's slug. The deletion starts right away.",
          },
        ],
        limits: {
          headers: { promise: 'What you can rely on', limit: 'The limit' },
          rows: [
            {
              promise: 'Expired events are permanently deleted.',
              limit: "There's no archive and no undo.",
            },
            {
              promise: 'Only an owner or admin can change a project’s retention.',
              limit: 'An owner or admin can shorten it at any time. There is no retention lock or legal hold yet.',
            },
          ],
        },
      },
      {
        id: 'export',
        eyebrow: 'The evidence export',
        title: 'Hand over a file, and show it matches the record.',
        steps: [
          {
            title: 'Choose what to export',
            body: 'In the explorer, set the project, the time range and the filter. Every member of the workspace can export.',
          },
          {
            title: 'Download the complete export',
            body: 'Pick **Complete (original payloads)**. Each line holds one event: the fields Logbird stored, and the original JSON it stored from what you sent, with every digit of its numbers (not its whitespace or how a number was spelled).',
          },
          {
            title: 'Logbird records the export',
            body: "Workspace activity gets a record when the export starts and another when it completes. The completed record keeps the export's id, the format, the filter and time range it resolved, the fixed query clock, the SHA-256 of the file, its size and its number of rows.",
          },
          {
            title: 'Match the file to its record',
            body: 'Compute the SHA-256 and size of the file you hold, and compare them with the completed record.',
            code: { title: 'Linux and macOS', code: `sha256sum ${file}\nwc -c ${file}`, language: 'bash' },
          },
        ],
        limit: {
          label: 'What a match shows',
          text: 'A matching SHA-256 and size show that the file you hold is the file Logbird produced for that export. They do not show who saved it or when, and they do not show that the events were never changed before the export ran.',
        },
      },
      {
        id: 'windows',
        eyebrow: 'On Windows',
        title: 'The same check in PowerShell.',
        steps: [
          {
            title: 'Compute the SHA-256 and size',
            body: 'Then compare both values with the completed export record.',
            code: { title: 'PowerShell', code: `Get-FileHash -Algorithm SHA256 ${file}\n(Get-Item ${file}).Length`, language: 'bash' },
          },
        ],
        limit: {
          label: 'Which events are in it',
          text: 'An export holds the matching events Logbird had received when it started. An event received after that, even one that happened earlier, is not in it.',
        },
      },
      {
        id: 'activity',
        eyebrow: 'Workspace activity',
        title: "Logbird's own record of what your team does.",
        points: [
          {
            title: 'Projects and retention',
            body: 'Creating, changing and deleting projects, and every retention change with its before and after.',
          },
          { title: 'Keys', body: 'Keys created, rolled and revoked, without the key itself.' },
          { title: 'People', body: 'Invitations, members joining or leaving, and role changes.' },
          { title: 'Exports', body: 'Each export requested, and how it ended.' },
          { title: 'Sessions', body: 'Sign-ins, failed sign-in attempts, sign-outs and revoked sessions.' },
        ],
        limit: { label: 'The limit', text: "It doesn't record who searched or opened events." },
      },
      {
        id: 'not',
        eyebrow: "What Logbird doesn't do",
        title: 'Say these out loud before an auditor asks.',
        limits: {
          headers: { promise: 'Question', limit: 'Answer' },
          rows: [
            {
              promise: 'Is Logbird certified (SOC 2, ISO 27001…)?',
              limit: "No. Logbird holds no certification, and using it doesn't make you compliant with any law or standard.",
            },
            {
              promise: 'Can stored events be shown to be unchanged?',
              limit: 'No. Logbird has no way to show that stored events were never changed.',
            },
            {
              promise: 'Can events be held past their retention, or deletion be blocked?',
              limit: 'No. There is no legal hold or retention lock yet.',
            },
          ],
        },
        cta: { label: 'Read how Logbird handles data', to: '/security' },
      },
    ],
  };
}

export const complianceEvidence: UseCase = complianceEvidenceContent(SITE);
