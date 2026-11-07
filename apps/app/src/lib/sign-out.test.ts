import { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { expect, it, vi } from 'vitest';
import { signOut } from '@/lib/auth-client';
import { signOutFromConsole } from './sign-out';

vi.mock('@/lib/auth-client', () => ({ signOut: vi.fn() }));
vi.mock('@/lib/api/queries', () => ({ meQuery: () => ({ queryKey: ['me'] }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));

it('shows a failed sign-out without navigation or cache clearing, then removes the toast before a successful retry', async () => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const clear = vi.spyOn(client, 'clear');
  const navigate = vi.fn(async () => {
    expect(toast.dismiss).toHaveBeenCalledWith('sign-out');
    expect(clear).not.toHaveBeenCalled();
  });
  vi.mocked(signOut).mockRejectedValueOnce(new Error('Sign-out failed. Retry shortly.')).mockResolvedValueOnce(undefined);
  await signOutFromConsole(client, navigate);
  expect(toast.error).toHaveBeenCalledWith('Could not sign out', { id: 'sign-out', description: 'Sign-out failed. Retry shortly.' });
  expect(invalidate).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  expect(toast.dismiss).not.toHaveBeenCalled();
  await signOutFromConsole(client, navigate);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me'], exact: true, refetchType: 'none' });
  expect(navigate).toHaveBeenCalledOnce();
  expect(clear).toHaveBeenCalledOnce();
});
