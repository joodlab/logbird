import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { keys } from '@/lib/api/queries';

/** Everything that changes setup state refreshes the project (setup, overview, keys…) and the workspace summary. */
export function useInvalidateSetup(projectId: string) {
  const queryClient = useQueryClient();
  return useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.project(projectId) }),
        queryClient.invalidateQueries({ queryKey: keys.workspaceSetup }),
      ]),
    [queryClient, projectId],
  );
}

export function useDismissSetup(projectId: string) {
  const invalidate = useInvalidateSetup(projectId);
  return useMutation({
    mutationFn: (dismissed: boolean) => api.projects.update(projectId, { setupDismissed: dismissed }),
    onSuccess: (_, dismissed) => {
      invalidate();
      if (dismissed) toast('Setup checklist hidden', { description: 'Reopen it any time from Setup in the sidebar.' });
    },
    onError: (error) => toast.error('Could not update the checklist', { description: errorMessage(error) }),
  });
}

export function useReviewRetention(projectId: string) {
  const invalidate = useInvalidateSetup(projectId);
  return useMutation({
    mutationFn: () => api.projects.update(projectId, { retentionReviewed: true }),
    onSuccess: () => {
      invalidate();
      toast.success('Retention reviewed');
    },
    onError: (error) => toast.error('Could not save the review', { description: errorMessage(error) }),
  });
}

export function useSampleData(projectId: string) {
  const invalidate = useInvalidateSetup(projectId);
  const load = useMutation({
    mutationFn: () => api.projects.loadSampleData(projectId),
    onSuccess: (result) => {
      invalidate();
      toast.success(`Loaded ${result.inserted.toLocaleString()} sample events`, {
        description: 'Explore them freely — they never count toward setup.',
      });
    },
    onError: (error) => toast.error('Could not load sample data', { description: errorMessage(error) }),
  });
  const remove = useMutation({
    mutationFn: () => api.projects.removeSampleData(projectId),
    onSuccess: () => {
      invalidate();
      toast.success('Sample data removed');
    },
    onError: (error) => toast.error('Could not remove sample data', { description: errorMessage(error) }),
  });
  return { load, remove };
}

export function useTestEvent(projectId: string) {
  const invalidate = useInvalidateSetup(projectId);
  return useMutation({
    mutationFn: () => api.events.testEvent(projectId),
    onSuccess: () => {
      invalidate();
      toast.success('Test event accepted', { description: 'It shows up here within a few seconds.' });
    },
    onError: (error) => toast.error('Could not send the test event', { description: errorMessage(error) }),
  });
}
