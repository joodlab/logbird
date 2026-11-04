import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import type { Project } from '@trailmark/contracts';
import { OutcomeDot } from '@trailmark/ui/components/badges';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@trailmark/ui/components/ui/alert-dialog';
import { Button } from '@trailmark/ui/components/ui/button';
import { Input } from '@trailmark/ui/components/ui/input';
import { Label } from '@trailmark/ui/components/ui/label';
import { Skeleton } from '@trailmark/ui/components/ui/skeleton';
import { Loader2Icon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { RetentionPicker } from '@/components/retention-picker';
import { SettingsSection } from '@/components/settings-section';
import { api } from '@/lib/api/client';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import { keys, projectQuery, retentionQuery } from '@/lib/api/queries';
import { formatDate, formatFull, formatNumber, formatRelative, formatRetention } from '@/lib/format';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/retention')({
  staticData: { crumb: 'Retention' },
  component: RetentionSettings,
});

const DAY = 86_400_000;

function RetentionSettings() {
  const { projectId } = Route.useParams();
  const project = useQuery(projectQuery(projectId));
  if (!project.data) return <Skeleton className="h-96 w-full rounded-xl" />;
  return <RetentionForm key={`${project.data.id}-${project.data.retentionDays}`} project={project.data} />;
}

function RetentionForm({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const status = useQuery(retentionQuery(project.id, project.retentionDays));
  const [days, setDays] = useState(project.retentionDays);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const lowering = days < project.retentionDays;
  const changed = days !== project.retentionDays;
  const cutoff = new Date(Date.now() - days * DAY);

  // Rough size of what a lower window deletes: events between the oldest stored and the new cutoff.
  const doomed = useQuery({
    queryKey: [...keys.project(project.id), 'retention-impact', days],
    enabled: lowering,
    queryFn: ({ signal }) =>
      api.events.search(
        project.id,
        { from: new Date(Date.now() - project.retentionDays * DAY).toISOString(), to: cutoff.toISOString(), limit: 1 },
        signal,
      ),
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: (confirm?: string) => api.projects.update(project.id, { retentionDays: days, confirm }),
    onSuccess: async (updated) => {
      setConfirmOpen(false);
      await queryClient.invalidateQueries({ queryKey: keys.project(project.id) });
      await queryClient.invalidateQueries({ queryKey: keys.projects });
      toast.success(`Retention set to ${formatRetention(updated.retentionDays)}`, {
        description: lowering ? 'Events past the new window were permanently deleted.' : 'Older events will now be kept longer.',
      });
    },
    onError: (error) => {
      if (!(error instanceof ApiRequestError && error.code === 'confirmation_required'))
        toast.error('Could not change retention', { description: errorMessage(error) });
    },
  });

  const run = status.data?.lastRun;

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection
        description={
          <>
            Events older than the retention window are <span className="font-medium text-foreground">permanently deleted</span> — from search,
            dashboards, entity pages and exports. There is no archive and no undo.
          </>
        }
        footer={
          <>
            {changed ? (
              <Button onClick={() => setDays(project.retentionDays)} size="sm" variant="ghost">
                Cancel
              </Button>
            ) : null}
            <Button
              disabled={!changed || save.isPending}
              onClick={() => (lowering ? setConfirmOpen(true) : save.mutate(undefined))}
              size="sm"
              variant={lowering ? 'destructive' : 'default'}
            >
              {save.isPending && !lowering ? <Loader2Icon className="animate-spin" /> : null}
              {lowering ? 'Lower retention…' : 'Save retention'}
            </Button>
          </>
        }
        title="Retention"
      >
        <RetentionPicker current={project.retentionDays} onChange={setDays} value={days} />
        {lowering ? (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span>
              Lowering to {formatRetention(days)} deletes every event before <span className="font-medium">{formatDate(cutoff.toISOString())}</span>
              {doomed.data ? (
                <>
                  {' '}
                  — about <span className="font-medium tabular-nums">{formatNumber(doomed.data.total)}</span> events
                </>
              ) : null}
              . It happens as soon as you confirm.
            </span>
          </p>
        ) : changed ? (
          <p className="text-muted-foreground text-sm">Raising retention keeps future events longer. Events already deleted do not come back.</p>
        ) : null}
      </SettingsSection>

      <SettingsSection description="A purge job runs every hour, and immediately after retention is lowered." title="Status">
        {status.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : status.isError ? (
          <p className="text-muted-foreground text-sm">Retention status is not available from this server yet ({errorMessage(status.error)}).</p>
        ) : (
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground text-xs">Current window</dt>
              <dd className="font-medium">{formatRetention(status.data.retentionDays)}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground text-xs">Oldest event</dt>
              <dd className="font-medium" title={status.data.oldestEventAt ? formatFull(status.data.oldestEventAt) : undefined}>
                {status.data.oldestEventAt
                  ? `${formatDate(status.data.oldestEventAt)} · ${formatRelative(status.data.oldestEventAt)}`
                  : 'No events stored'}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground text-xs">Last purge</dt>
              <dd className="flex items-center gap-1.5 font-medium">
                {run ? (
                  <>
                    <OutcomeDot outcome={run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'failure' : 'unknown'} />
                    {run.status} {formatRelative(run.finishedAt ?? run.startedAt)}
                  </>
                ) : (
                  <span className="font-normal text-muted-foreground">Runs hourly — no run reported</span>
                )}
              </dd>
              {run ? <span className="text-muted-foreground text-xs">Deleted events before {formatDate(run.cutoff)}</span> : null}
              {run?.error ? <span className="text-destructive text-xs">{run.error}</span> : null}
            </div>
          </dl>
        )}
      </SettingsSection>

      <LowerRetentionDialog
        days={days}
        doomed={doomed.data?.total}
        error={save.error instanceof ApiRequestError && save.error.code === 'confirmation_required' ? save.error.message : null}
        onConfirm={(slug) => save.mutate(slug)}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) save.reset();
        }}
        open={confirmOpen}
        pending={save.isPending}
        project={project}
        cutoff={cutoff}
      />
    </div>
  );
}

function LowerRetentionDialog({
  open,
  onOpenChange,
  project,
  days,
  cutoff,
  doomed,
  onConfirm,
  pending,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  days: number;
  cutoff: Date;
  doomed: number | undefined;
  onConfirm: (slug: string) => void;
  pending: boolean;
  error: string | null;
}) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === project.slug;
  return (
    <AlertDialog
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setTyped('');
      }}
      open={open}
    >
      <AlertDialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (matches) onConfirm(typed.trim());
          }}
        >
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <TriangleAlertIcon />
            </AlertDialogMedia>
            <AlertDialogTitle>Permanently delete older events?</AlertDialogTitle>
            <AlertDialogDescription>
              Lowering <span className="font-medium text-foreground">{project.name}</span> from {formatRetention(project.retentionDays)} to{' '}
              {formatRetention(days)} deletes every event before{' '}
              <span className="font-medium text-foreground">{formatFull(cutoff.toISOString())}</span>
              {doomed !== undefined ? ` (about ${formatNumber(doomed)} events)` : ''}. They are removed from search, dashboards and exports, and
              cannot be recovered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-slug">
              Type <span className="font-mono font-semibold">{project.slug}</span> to confirm
            </Label>
            <Input
              autoComplete="off"
              autoFocus
              id="confirm-slug"
              onChange={(e) => setTyped(e.target.value)}
              placeholder={project.slug}
              spellCheck={false}
              value={typed}
            />
            {error ? <p className="text-destructive text-xs">{error}</p> : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Keep {formatRetention(project.retentionDays)}</AlertDialogCancel>
            <Button disabled={!matches || pending} type="submit" variant="destructive">
              {pending ? <Loader2Icon className="animate-spin" /> : null}
              Delete and lower to {formatRetention(days)}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
