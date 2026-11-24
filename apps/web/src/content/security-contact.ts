import { SECURITY_EMAIL } from '../env';

/**
 * How to report a vulnerability (components/marketing/security-contact.tsx, on /security and /contact). With
 * WEB_SECURITY_EMAIL set it's that mailbox; until then the site repeats SECURITY.md ("request a private channel from the
 * maintainers") and points to the contact form. It never guesses an address on a domain we don't control. Each entry is
 * the text before and after its link. Brief: marketing/copy/security.md and marketing/copy/contact.md.
 */
export function securityContactContent(securityEmail?: string) {
  return {
    email: securityEmail ? { before: 'Email', href: `mailto:${securityEmail}`, label: securityEmail, after: '.' } : undefined,
    /** On /contact itself: a link to the form section. */
    onContactPage: {
      before: 'Use the',
      link: 'form',
      after: 'to ask the maintainers for a private channel (choose "A question"), without any details of the issue.',
    },
    /** Anywhere else: a link to the contact form with "A question" preselected. */
    elsewhere: {
      before: 'Ask the maintainers for a private channel through the',
      link: 'contact form',
      after: ', without any details of the issue.',
    },
  };
}

export const securityContact = securityContactContent(SECURITY_EMAIL);
