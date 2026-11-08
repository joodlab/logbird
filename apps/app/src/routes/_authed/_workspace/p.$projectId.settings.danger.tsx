import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@logbird/ui/components/ui/alert-dialog';
import { Button } from '@logbird/ui/components/ui/button';
import { Input } from '@logbird/ui/components/ui/input';
import { Label } from '@logbird/ui/components/ui/label';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { HourglassIcon, Loader2Icon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AdminNote, AdminOnly } from '@/components/admin-gate';
import { PendingHint } from '@/components/pending-hint';
import { SettingsSection } from '@/components/settings-section';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { keys, projectQuery } from '@/lib/api/queries';
import { formatNumber } from '@/lib/format';
import { useCan } from '@/lib/permissions';
import { deleteBlockedMessage, deleteRetryAt, secondsUntil } from '@/lib/project-delete';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/danger')({
  head: () => ({ meta: [{ title: 'Danger zone · Settings · Logbird' }] }),
  staticData: { crumb: 'Danger zone' },
  component: DangerZone,
});

function DangerZone() {
  const { projectId } = Route.useParams();
  const project = useQuery(projectQuery(projectId));
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const slugInput = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  const manage = useCan()('project.delete');
  /** Set when the server refused because events were still being written (503 ingest_pending): retry after it. */
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt === null) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [retryAt]);
  const remove = useMutation({
    // The confirmed slug travels with the request, so a retry does not depend on the input still holding it.
    mutationFn: (slug: string) => api.projects.remove(projectId, slug),
    onMutate: () => setRetryAt(null),
    onSuccess: async () => {
      setOpen(false);
      // The deletion keeps running if the person left this page meanwhile: only bring them home when they are still
      // inside the deleted project (its pages would 404 now).
      const stillHere = router.state.location.pathname.startsWith(`/p/${projectId}`);
      toast.success(`Deleted ${project.data?.name}`, { description: 'The project and all of its events are gone.' });
      // Leave first, then drop the deleted project's cache: mounted project pages would otherwise refetch it into 404s.
      if (stillHere) await navigate({ to: '/' });
      queryClient.removeQueries({ queryKey: keys.project(projectId) });
      await queryClient.invalidateQueries({ queryKey: keys.projects, exact: true });
    },
    onError: (error, slug) => {
      const at = deleteRetryAt(error);
      if (at === null) {
        toast.error('Could not delete the project', { description: errorMessage(error) });
        return;
      }
      // Nothing was deleted. Keep (or reopen) the dialog with the confirmation filled in and a retry button.
      setNow(Date.now());
      setRetryAt(at);
      setTyped(slug);
      setOpen(true);
    },
  });
  const waitLeft = retryAt === null ? 0 : secondsUntil(retryAt, now);

  if (!project.data) return <Skeleton className="h-40 w-full rounded-xl" />;
  const p = project.data;
  const matches = typed.trim() === p.slug;

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection
        description={
          <>
            Deletes <span className="font-medium text-foreground">{p.name}</span>, its API keys, saved views and every stored event. Products still
            sending to its keys will get 401s. This cannot be undone.
          </>
        }
        footer={
          <AdminOnly allowed={manage}>
            <Button disabled={!manage} onClick={() => setOpen(true)} ref={deleteButton} size="sm" variant="destructive">
              <Trash2Icon />
              Delete project…
            </Button>
          </AdminOnly>
        }
        title="Delete project"
        tone="danger"
      >
        <p className="text-muted-foreground text-sm">
          Last 24 hours: <span className="font-medium text-foreground tabular-nums">{formatNumber(p.eventsLast24h)}</span> events received.
        </p>
        {manage ? null : <AdminNote>Only workspace owners and admins can delete a project.</AdminNote>}
      </SettingsSection>
      <AlertDialog
        onOpenChange={(next) => {
          setOpen(next);
          if (!next && !remove.isPending) {
            setTyped('');
            setRetryAt(null);
          }
        }}
        open={open && manage}
      >
        <AlertDialogContent className="sm:max-w-md" finalFocus={deleteButton} initialFocus={slugInput}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (matches && waitLeft === 0) remove.mutate(typed.trim());
            }}
          >
            <AlertDialogHeader>
              <AlertDialogMedia className="bg-destructive/10 text-destructive">
                <Trash2Icon />
              </AlertDialogMedia>
              <AlertDialogTitle>Delete {p.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Every event, key and saved view in this project is permanently deleted. Workspace activity keeps a record that you did this.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="delete-slug">
                Type <span className="font-mono font-semibold">{p.slug}</span> to confirm
              </Label>
              <Input
                autoComplete="off"
                id="delete-slug"
                onChange={(e) => setTyped(e.target.value)}
                placeholder={p.slug}
                ref={slugInput}
                spellCheck={false}
                value={typed}
              />
            </div>
            {retryAt !== null && !remove.isPending ? (
              <p
                className="flex items-start gap-2 rounded-lg border border-outcome-denied/30 bg-outcome-denied/[0.07] px-3 py-2.5 text-sm"
                data-testid="delete-retry-notice"
                role="status"
              >
                <HourglassIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-outcome-denied" />
                <span>{deleteBlockedMessage(retryAt, now)}</span>
              </p>
            ) : null}
            <PendingHint
              pending={remove.isPending}
              slow={`Deleting ${p.name}: removing its events, keys and saved views…`}
              slower="Projects with many events can take a few minutes. You can leave this page — the deletion continues, and you will see a confirmation when it is done."
            />
            <AlertDialogFooter>
              {/* While deleting, this only hides the dialog: the request keeps running. */}
              <AlertDialogCancel type="button">{remove.isPending ? 'Hide' : 'Cancel'}</AlertDialogCancel>
              <Button data-testid="delete-project-submit" disabled={!matches || remove.isPending || waitLeft > 0} type="submit" variant="destructive">
                {remove.isPending ? <Loader2Icon className="animate-spin" /> : null}
                {retryAt === null ? 'Delete project' : waitLeft > 0 ? `Try again in ${waitLeft} s` : 'Try again'}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
