import { Link } from '@tanstack/react-router';
import { SECURITY_EMAIL } from '../../env';

/**
 * How to report a vulnerability. With WEB_SECURITY_EMAIL set it's that mailbox; until then the site repeats
 * SECURITY.md ("request a private channel from the maintainers") and points to the contact form. It never guesses an
 * address on a domain we don't control.
 */
export function SecurityContact() {
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
  return (
    <>
      Ask the maintainers for a private channel through the{' '}
      <Link className="text-link" search={{ interest: 'other' }} to="/contact">
        contact form
      </Link>
      , and don't include details of the issue there.
    </>
  );
}
