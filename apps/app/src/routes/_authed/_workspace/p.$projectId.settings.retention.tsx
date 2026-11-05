import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import type { Project, RetentionStatus } from '@trailmark/contracts';
import { OutcomeDot } from '@trailmark/ui/components/badges';
import { ErrorState } from '@trailmark/ui/components/states';
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
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { AdminNote } from '@/components/admin-gate';
import { RetentionPicker } from '@/components/retention-picker';
import { SettingsSection } from '@/components/settings-section';
import { Timestamp } from '@/components/timestamp';
import { api } from '@/lib/api/client';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import { keys, projectQuery, retentionQuery } from '@/lib/api/queries';
import { formatNumber, formatRetention, pluralize } from '@/lib/format';
import { useCan } from '@/lib/permissions';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/retention')({
  head: () => ({ meta: [{ title: 'Retention · Settings · Trailmark' }] }),
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
  const status = useQuery(retentionQuery(project.id));
  const [days, setDays] = useState(project.retentionDays);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const manage = useCan()('retention.manage');
  const lowering = days < project.retentionDays;
  const changed = days !== project.retentionDays;
  const cutoff = new Date(Date.now() - days * DAY);

  // The server counts exactly what a lower window deletes (`?preview=<days>`).
  const preview = useQuery({ ...retentionQuery(project.id, days), enabled: lowering, placeholderData: keepPreviousData });
  const doomed = lowering && preview.data && !preview.isPlaceholderData ? (preview.data.previewDeletedEvents ?? undefined) : undefined;

  const save = useMutation({
    mutationFn: (confirm?: string) => api.projects.update(project.id, { retentionDays: days, confirm }),
    onSuccess: async (updated) => {
      setConfirmOpen(false);
      await queryClient.invalidateQueries({ queryKey: keys.project(project.id) });
      await queryClient.invalidateQueries({ queryKey: keys.projects });
      toast.success(`Retention set to ${formatRetention(updated.retentionDays)}`, {
        description: lowering
          ? `${doomed === undefined ? 'Events' : pluralize(doomed, 'event')} past the new window ${doomed === 1 ? 'was' : 'were'} permanently deleted.`
          : 'Future events will be kept longer.',
      });
    },
    onError: (error) => {
      if (!(error instanceof ApiRequestError && error.code === 'confirmation_required'))
        toast.error('Could not change retention', { description: errorMessage(error) });
    },
  });

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
          manage ? (
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
          ) : undefined
        }
        title="Retention"
      >
        {manage ? null : <AdminNote>Only workspace owners and admins can change how long this project keeps events.</AdminNote>}
        <RetentionPicker current={project.retentionDays} disabled={!manage} onChange={setDays} value={days} />
        {lowering ? (
          <div
            className="tm-fade-in flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm"
            role="status"
          >
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p>
              Lowering to {formatRetention(days)} deletes every event before{' '}
              <Timestamp className="font-medium" format="full" iso={cutoff.toISOString()} />.{' '}
              <DoomedCount count={doomed} error={preview.isError} loading={preview.isFetching} /> It happens as soon as you confirm.
            </p>
          </div>
        ) : changed ? (
          <p className="text-muted-foreground text-sm">Raising retention keeps future events longer. Events already deleted do not come back.</p>
        ) : null}
      </SettingsSection>

      <SettingsSection description="A purge job runs every hour, and immediately after retention is lowered." title="Status">
        {status.isPending ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : status.isError ? (
          <ErrorState className="py-6" error={status.error} onRetry={() => status.refetch()} title="Retention status is unavailable" />
        ) : (
          <RetentionStatusGrid status={status.data} />
        )}
      </SettingsSection>

      <LowerRetentionDialog
        cutoff={cutoff}
        days={days}
        doomed={doomed}
        error={save.error instanceof ApiRequestError && save.error.code === 'confirmation_required' ? save.error.message : null}
        onConfirm={(slug) => save.mutate(slug)}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) save.reset();
        }}
        open={confirmOpen}
        pending={save.isPending}
        project={project}
      />
    </div>
  );
}

function DoomedCount({ count, loading, error }: { count: number | undefined; loading: boolean; error: boolean }) {
  if (count !== undefined)
    return (
      <span>
        That is <span className="font-semibold tabular-nums">{pluralize(count, 'event')}</span>
        {count === 0 ? ' — nothing is old enough to be removed yet.' : '.'}
      </span>
    );
  if (loading)
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Loader2Icon className="size-3 animate-spin" /> Counting affected events…
      </span>
    );
  if (error) return <span className="text-muted-foreground">The number of affected events could not be counted.</span>;
  return null;
}

function StatusItem({ label, children, detail }: { label: string; children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 font-medium text-sm">{children}</dd>
      {detail ? <dd className="text-muted-foreground text-xs">{detail}</dd> : null}
    </div>
  );
}

const RUN_OUTCOME: Record<string, string> = { completed: 'success', succeeded: 'success', failed: 'failure', running: 'unknown' };

function RetentionStatusGrid({ status }: { status: RetentionStatus }) {
  const run = status.lastRun;
  return (
    <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
      <StatusItem label="Current window">{formatRetention(status.retentionDays)}</StatusItem>
      <StatusItem detail={status.oldestEventAt ? <Timestamp format="relative" iso={status.oldestEventAt} /> : null} label="Oldest event">
        {status.oldestEventAt ? (
          <Timestamp format="date" iso={status.oldestEventAt} />
        ) : (
          <span className="font-normal text-muted-foreground">No events stored</span>
        )}
      </StatusItem>
      <StatusItem
        detail={
          run ? (
            run.error ? (
              <span className="text-destructive">{run.error}</span>
            ) : (
              <>
                {run.deletedEvents === null ? 'Removed' : `Removed ${pluralize(run.deletedEvents, 'event')}`} before{' '}
                <Timestamp format="date" iso={run.cutoff} />
              </>
            )
          ) : null
        }
        label="Last purge"
      >
        {run ? (
          <>
            <OutcomeDot outcome={RUN_OUTCOME[run.status] ?? 'unknown'} />
            <span className="capitalize">{run.status}</span>
            <Timestamp className="font-normal text-muted-foreground" format="relative" iso={run.finishedAt ?? run.startedAt} />
          </>
        ) : (
          <span className="font-normal text-muted-foreground">No purge has run yet</span>
        )}
      </StatusItem>
      <StatusItem
        detail={status.nextPurgeAt ? <Timestamp format="full" iso={status.nextPurgeAt} /> : 'The worker schedules it hourly'}
        label="Next purge"
      >
        {status.nextPurgeAt ? (
          <Timestamp format="relative" iso={status.nextPurgeAt} />
        ) : (
          <span className="font-normal text-muted-foreground">Not scheduled</span>
        )}
      </StatusItem>
    </dl>
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
            <AlertDialogTitle>{doomed ? `Permanently delete ${formatNumber(doomed)} events?` : 'Permanently delete older events?'}</AlertDialogTitle>
            <AlertDialogDescription>
              Lowering <span className="font-medium text-foreground">{project.name}</span> from {formatRetention(project.retentionDays)} to{' '}
              {formatRetention(days)} deletes every event before{' '}
              <Timestamp className="font-medium text-foreground" format="full" iso={cutoff.toISOString()} />. They are removed from search, dashboards
              and exports, and cannot be recovered.
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
