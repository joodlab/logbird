import { EntityAvatar } from '@trailmark/ui/components/entity-chip';
import { displayName } from '@/lib/user';

/**
 * The one avatar for console users (sidebar, members, account, onboarding): initials of their name, or of their
 * email until they add a name, on a hue derived from the user id so a person keeps their colour everywhere.
 */
export function UserAvatar({
  user,
  size = 'md',
  className,
}: {
  user: { id: string; name?: string | null; email: string } | null | undefined;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return <EntityAvatar className={className} id={user?.id ?? ''} name={displayName(user)} size={size} />;
}
