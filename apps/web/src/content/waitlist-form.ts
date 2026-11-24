import { CONTACT_EMAIL } from '../env';
import type { INTERESTS, NEEDS, VOLUMES } from '../lib/waitlist-options';
import { byCloud, byRepo, SITE, type SiteState } from './site';

/** Text around the contact mailbox, which the form renders as a link between `before` and `after`. */
export interface AroundMail {
  before: string;
  after: string;
}

/**
 * Words of the contact and early-access form (components/waitlist-form.tsx): labels, options, the placeholder, the
 * button, the consent sentence and the status messages. The consent and privacy sentences are the owner's to change.
 * No mailbox is named unless WEB_CONTACT_EMAIL is configured (never a guessed address). Brief: marketing/copy/contact.md.
 */
export function waitlistFormContent(site: SiteState, contactEmail?: string) {
  const mail = contactEmail ? { href: `mailto:${contactEmail}`, label: contactEmail } : undefined;
  const status: Record<string, string | AroundMail> = {
    // One message for every topic: a privacy request must not be told it joined a waitlist.
    ok: "Thanks, we've got it. We'll reply by email.",
    validation_error: 'Something in the form needs fixing. Check the email address and try again.',
    invalid_body: 'Something in the form needs fixing. Check the email address and try again.',
    rate_limited: 'Too many attempts. Wait a minute, then try again.',
    waitlist_unavailable: mail
      ? { before: "The form isn't available right now. Email us at ", after: ' instead.' }
      : "The form isn't available right now. Please try again later.",
    error: mail
      ? { before: "We couldn't send that. Check your connection and try again, or email ", after: '.' }
      : "We couldn't send that. Check your connection and try again.",
  };
  const interests: Record<(typeof INTERESTS)[number], string> = {
    cloud: byCloud(site, { open: 'Access to Logbird Cloud', closed: 'The Logbird Cloud waitlist' }),
    'self-host': byRepo(site, { public: 'Self-hosting', private: 'Self-hosting, when the source opens' }),
    updates: 'Product updates only',
    correction: 'A correction to one of our pages',
    other: 'A question, or support and enterprise',
    privacy: 'A privacy request (access, deletion or another right)',
  };
  const volumes: Record<(typeof VOLUMES)[number], string> = {
    unsure: 'Not sure yet',
    'under-100k': 'Under 100,000',
    '100k-1m': '100,000 to under 1 million',
    '1m-10m': '1 million to under 10 million',
    'over-10m': '10 million or more',
  };
  const needs: Record<(typeof NEEDS)[number], string> = {
    'customer-audit-log': 'Show our customers their own audit log',
    compliance: 'Compliance evidence and retention',
    investigations: 'Support investigations',
    'self-host-support': 'Help running it ourselves',
    other: 'Something else',
  };
  return {
    mail,
    status,
    interests,
    volumes,
    needs,
    /** Shown under the email field when the server rejects it; other fields show the server's own message. */
    emailInvalid: 'Enter a valid email address.',
    labels: {
      email: 'Email',
      name: 'Name',
      company: 'Company',
      interest: "What's this about?",
      volume: 'Expected events per month (optional)',
      volumeNone: 'Choose one',
      needs: 'What do you need? (optional)',
      message: 'Message',
      /** The hidden honeypot field's label. */
      website: 'Website',
    },
    emailPlaceholder: 'you@example.test',
    messageHint: "What are you building, and what do you need from an audit log? For a privacy request, tell us what you'd like us to do.",
    submit: { idle: 'Send', sending: 'Sending…' },
    /** The consent line under the button; `link` is the privacy policy's link text. */
    consent: {
      before:
        'We use these details to reply to you and handle access requests, and send product updates only if you choose "Product updates only". No trackers. By sending, you confirm you\'ve read the',
      link: 'privacy policy',
      after: '.',
    },
  };
}

export const waitlistForm = waitlistFormContent(SITE, CONTACT_EMAIL);
