import { Link } from '@tanstack/react-router';
import { SECURITY_EMAIL } from '../../env';

/**
 * How to report a vulnerability. With WEB_SECURITY_EMAIL set it's that mailbox; until then the site repeats
 * SECURITY.md ("request a private channel from the maintainers") and points to the contact form. It never guesses an
 * address on a domain we don't control.
 */
export function SecurityContact({ onContactPage = false }: { onContactPage?: boolean }) {
  if (SECURITY_EMAIL) {
    return (
      <>
        Email{' '}
        <a className="text-link" href={`mailto:${SECURITY_EMAIL}`}>
          {SECURITY_EMAIL}
        </a>
        .
      </>
    );
  }
  if (onContactPage) {
    // Same page: point at the form section instead of navigating to ourselves (which wouldn't reset the form).
    return (
      <>
        Use the{' '}
        <a className="text-link" href="#waitlist-title">
          form
        </a>{' '}
        to ask the maintainers for a private channel (choose "A question"), without any details of the issue.
      </>
    );
  }
  return (
    <>
      Ask the maintainers for a private channel through the{' '}
      <Link className="text-link" search={{ interest: 'other' }} to="/contact">
        contact form
      </Link>
      , without any details of the issue.
    </>
  );
}
