import { Link } from '@tanstack/react-router';
import {
  EMAIL_PROVIDER,
  FORM_RETENTION_MONTHS,
  GOVERNING_LAW,
  HOSTING_PROVIDER,
  LEGAL_ADDRESS,
  MAILBOX_PROVIDER,
  ORG_NAME,
  PRIVACY_EMAIL,
} from '../env';
import { publicationDate } from './publications';

/**
 * The facts the privacy policy and terms depend on. Facts only the owner can supply (the legal entity, its address,
 * governing law, the server and email providers, a privacy mailbox) come from WEB_* settings, and each has wording
 * that stays true while it is unset. Promises that are policy rather than code (the notice before fees) are constants
 * here, listed for the owner to confirm in marketing/copy/legal-privacy.md.
 */

/** The date the current texts took effect. Change it with every substantive edit. */
export const EFFECTIVE_DATE = '2026-11-10';
export const effectiveDateLabel = publicationDate(EFFECTIVE_DATE);

/** Who "we" are. Unset, the texts name the role instead of a company (the publisher name is a release blocker). */
export const OPERATOR = ORG_NAME ?? 'the operator of Logbird Cloud';
export const OPERATOR_SENTENCE_START = ORG_NAME ?? 'The operator of Logbird Cloud';

/**
 * How long we keep form submissions and the emails about them (WEB_FORM_RETENTION_MONTHS, default 24). The site's own
 * copy is deleted automatically that long after it was sent (src/server/waitlist-retention.ts, or a KV expiry); the
 * mailbox copies are a manual commitment.
 */
export { FORM_RETENTION_MONTHS };
export const FORM_RETENTION = `${FORM_RETENTION_MONTHS} months after our last exchange with you`;

/** How long after an account or workspace is closed we delete it (manual commitment). */
export const CLOSURE_DELETION_DAYS = 30;

/** Notice before Logbird Cloud stops being free. */
export const FEE_NOTICE_DAYS = 30;

export const HOSTING_PROVIDER_TEXT = HOSTING_PROVIDER ?? 'our server provider';
/** Logbird Cloud's transactional email goes through Postmark (operator configuration); WEB_EMAIL_PROVIDER overrides it. */
export const EMAIL_PROVIDER_TEXT = EMAIL_PROVIDER ?? 'Postmark';
export const MAILBOX_PROVIDER_TEXT = MAILBOX_PROVIDER ?? 'our mailbox provider';
export const GOVERNING_LAW_TEXT = GOVERNING_LAW ?? 'the laws of the country where the operator is established';
export { LEGAL_ADDRESS };

/** How to reach us about privacy: the mailbox once configured, otherwise the contact form's privacy topic. */
export function PrivacyContact() {
  if (PRIVACY_EMAIL) {
    return (
      <a className="text-link" href={`mailto:${PRIVACY_EMAIL}`}>
        {PRIVACY_EMAIL}
      </a>
    );
  }
  return (
    <>
      the{' '}
      <Link className="text-link" search={{ interest: 'privacy' }} to="/contact">
        contact form
      </Link>{' '}
      (choose "A privacy request")
    </>
  );
}

/** How to make a privacy request, as a clause: "To make a request, <PrivacyRequestHow />." */
export function PrivacyRequestHow() {
  if (PRIVACY_EMAIL) {
    return (
      <>
        email{' '}
        <a className="text-link" href={`mailto:${PRIVACY_EMAIL}`}>
          {PRIVACY_EMAIL}
        </a>{' '}
        from the address the request is about (your account's, or the one you gave in the form)
      </>
    );
  }
  return (
    <>
      use the{' '}
      <Link className="text-link" search={{ interest: 'privacy' }} to="/contact">
        contact form
      </Link>
      , choose "A privacy request" and enter the address the request is about (if you no longer have access to it, say so in your message and we'll
      find another way to check it's yours)
    </>
  );
}
