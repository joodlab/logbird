import type { MeResponse } from '@logbird/contracts';
import { Alert, AlertDescription, AlertTitle } from '@logbird/ui/components/ui/alert';
import { useEffect, useState } from 'react';
import { noteLostWorkspaces, takeLostWorkspaces, workspaceList } from '@/lib/session';

/**
 * Workspaces this person lost access to since this browser last saw them, read once (#4). It does not say who removed
 * them or why: an owner or an admin may have, or they left on another device.
 */
export function useLostWorkspaces(me: Pick<MeResponse, 'user' | 'organizations'>): string[] {
  const [lost, setLost] = useState<string[]>([]);
  useEffect(() => {
    noteLostWorkspaces(me);
    // Taken once: a later run (a new `me`) finds nothing and must not clear a notice already shown.
    const names = takeLostWorkspaces(me.user.id);
    if (names.length) setLost(names);
  }, [me]);
  return lost;
}

export const lostTitle = (names: readonly string[]) => `You no longer have access to ${workspaceList(names)}`;

/** The notice on every onboarding step: someone whose only workspace is gone is not greeted as brand new. */
export function LostWorkspacesAlert({ me }: { me: Pick<MeResponse, 'user' | 'organizations'> }) {
  const lost = useLostWorkspaces(me);
  if (!lost.length) return null;
  return (
    <Alert data-testid="lost-workspace">
      <AlertTitle>{lostTitle(lost)}</AlertTitle>
      <AlertDescription>
        {lost.length === 1 ? 'To return, ask one of its owners or admins' : 'To return to one, ask one of its owners or admins'} to invite you again
        {me.organizations.length ? '.' : ', or create a workspace of your own below.'}
      </AlertDescription>
    </Alert>
  );
}
