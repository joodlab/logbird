import type { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { meQuery } from '@/lib/api/queries';
import { signOut } from '@/lib/auth-client';

/** Preserve the live session on failure, and clear the error before a successful retry navigates. */
export async function signOutFromConsole(client: QueryClient, navigate: () => Promise<unknown>) {
  try {
    await signOut();
    toast.dismiss('sign-out');
    await client.invalidateQueries({ queryKey: meQuery().queryKey, exact: true, refetchType: 'none' });
    await navigate();
    client.clear();
  } catch (error) {
    toast.error('Could not sign out', { id: 'sign-out', description: error instanceof Error ? error.message : undefined });
  }
}
