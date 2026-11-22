import { shared } from '../../content/shared';
import { ButtonLink } from './button-link';

/**
 * The secondary call to action. Until the repository is public nobody can self-host, so it says so and leads to the
 * waitlist with "self-host" preselected instead of promising a quickstart. Words: content/shared.ts (selfHostCta).
 */
export function SelfHostCta({ size = 'lg', variant = 'outline' }: { size?: 'default' | 'lg'; variant?: 'outline' | 'ghost' }) {
  const cta = shared.selfHostCta;
  return (
    <ButtonLink search={cta.search} size={size} to={cta.to} variant={variant}>
      {cta.label}
    </ButtonLink>
  );
}
