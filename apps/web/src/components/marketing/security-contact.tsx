import { Link } from '@tanstack/react-router';
import { securityContact as words } from '../../content/security-contact';

/** How to report a vulnerability. Words, and when each applies: content/security-contact.ts. */
export function SecurityContact({ onContactPage = false }: { onContactPage?: boolean }) {
  if (words.email) {
    return (
      <>
        {words.email.before}{' '}
        <a className="text-link" href={words.email.href}>
          {words.email.label}
        </a>
        {words.email.after}
      </>
    );
  }
  if (onContactPage) {
    // Same page: point at the form section instead of navigating to ourselves (which wouldn't reset the form).
    return (
      <>
        {words.onContactPage.before}{' '}
        <a className="text-link" href="#waitlist-title">
          {words.onContactPage.link}
        </a>{' '}
        {words.onContactPage.after}
      </>
    );
  }
  return (
    <>
      {words.elsewhere.before}{' '}
      <Link className="text-link" search={{ interest: 'other' }} to="/contact">
        {words.elsewhere.link}
      </Link>
      {words.elsewhere.after}
    </>
  );
}
