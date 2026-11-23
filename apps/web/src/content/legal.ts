import { PRIVACY_EMAIL } from '../env';

/**
 * Words both legal pages share: the document's frame (components/marketing/legal-document.tsx), the wording that stands
 * in for an owner fact while its WEB_* setting is unset, and how to reach us about privacy. The facts and the env logic
 * stay in lib/legal-facts.tsx, which reads these words; this module imports nothing from it. The pages' own words are
 * content/legal-privacy.ts and content/legal-terms.ts. Brief: marketing/copy/legal-privacy.md and legal-terms.md; the
 * texts are owner-approved, so change no word here without the owner.
 */
export const legal = {
  document: {
    eyebrow: 'Legal',
    /** "Effective <date>." under the lead. */
    effective: { before: 'Effective ', after: '.' },
    contents: 'Contents',
  },
  /** What the texts say while an owner fact is unset (lib/legal-facts.tsx). */
  defaults: {
    /** Who "we" are, mid-sentence and at the start of one. */
    operator: 'the operator of Logbird Cloud',
    operatorSentenceStart: 'The operator of Logbird Cloud',
    hostingProvider: 'our server provider',
    /** Logbird Cloud's transactional email provider (operator configuration). */
    emailProvider: 'Postmark',
    mailboxProvider: 'our mailbox provider',
    governingLaw: 'the laws of the country where the operator is established',
  },
  /** The form-retention period as words: "24 months", or "1 month". */
  retentionPeriod: (months: number) => (months === 1 ? '1 month' : `${months} months`),
  /** How long the mailbox copies are kept, from that period. */
  retention: (period: string) => `${period} after our last exchange with you`,
  /** The privacy mailbox's link, once WEB_PRIVACY_EMAIL is set. */
  privacyHref: PRIVACY_EMAIL ? `mailto:${PRIVACY_EMAIL}` : undefined,
  /** How to reach us about privacy (PrivacyContact) without a privacy mailbox: the contact form's privacy topic. */
  privacyContactForm: { before: 'the ', label: 'contact form', after: ' (choose "A privacy request")' },
  /** How to make a privacy request, as a clause: "To make a request, <PrivacyRequestHow />." */
  privacyRequestHow: {
    email: { before: 'email ', after: " from the address the request is about (your account's, or the one you gave in the form)" },
    form: {
      before: 'use the ',
      label: 'contact form',
      after:
        ', choose "A privacy request" and enter the address the request is about (if you no longer have access to it, say so in your message and we\'ll find another way to check it\'s yours)',
    },
  },
} as const;
