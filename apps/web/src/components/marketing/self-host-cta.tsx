import { GITHUB_PUBLIC } from '../../env';
import { ButtonLink } from './button-link';

/**
 * The secondary call to action. Until the repository is public nobody can self-host, so it says so and leads to the
 * waitlist with "self-host" preselected instead of promising a quickstart.
 */
export function SelfHostCta({ size = 'lg', variant = 'outline' }: { size?: 'default' | 'lg'; variant?: 'outline' | 'ghost' }) {
  if (GITHUB_PUBLIC) {
    return (
      <ButtonLink size={size} to="/self-hosting" variant={variant}>
        Self-host it
      </ButtonLink>
    );
  }
  return (
    <ButtonLink search={{ interest: 'self-host' }} size={size} to="/contact" variant={variant}>
      Self-host when the source opens
    </ButtonLink>
  );
}

export const CTA_BODY = GITHUB_PUBLIC
  ? 'Self-host Logbird today, or join the waitlist for Logbird Cloud.'
  : 'The source opens soon. Join the waitlist to hear when you can self-host Logbird, and when Logbird Cloud opens.';
