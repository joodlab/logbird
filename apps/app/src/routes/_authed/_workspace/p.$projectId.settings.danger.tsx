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
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Loader2Icon, Trash2Icon } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { AdminNote, AdminOnly } from '@/components/admin-gate';
import { SettingsSection } from '@/components/settings-section';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { keys, projectQuery } from '@/lib/api/queries';
import { formatNumber } from '@/lib/format';
import { useCan } from '@/lib/permissions';

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
  const [open, setOpen] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const slugInput = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  const manage = useCan()('project.delete');
  const remove = useMutation({
    mutationFn: () => api.projects.remove(projectId, typed.trim()),
    onSuccess: async () => {
      setOpen(false);
      queryClient.removeQueries({ queryKey: keys.project(projectId) });
      await queryClient.invalidateQueries({ queryKey: keys.projects });
      toast.success(`Deleted ${project.data?.name}`, { description: 'The project and all of its events are gone.' });
      await navigate({ to: '/' });
    },
    onError: (error) => toast.error('Could not delete the project', { description: errorMessage(error) }),
  });

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
          if (!next) setTyped('');
        }}
        open={open && manage}
      >
        <AlertDialogContent className="sm:max-w-md" finalFocus={deleteButton} initialFocus={slugInput}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (matches) remove.mutate();
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
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
              <Button disabled={!matches || remove.isPending} type="submit" variant="destructive">
                {remove.isPending ? <Loader2Icon className="animate-spin" /> : null}
                Delete project
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
