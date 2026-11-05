import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { CopyValue } from '@trailmark/ui/components/copy-button';
import { Button } from '@trailmark/ui/components/ui/button';
import { Input } from '@trailmark/ui/components/ui/input';
import { Label } from '@trailmark/ui/components/ui/label';
import { Skeleton } from '@trailmark/ui/components/ui/skeleton';
import { Textarea } from '@trailmark/ui/components/ui/textarea';
import { ArrowRightIcon, BookOpenIcon, Loader2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { AdminNote } from '@/components/admin-gate';
import { SettingsSection } from '@/components/settings-section';
import { ProgressRing } from '@/components/setup/steps';
import { Timestamp } from '@/components/timestamp';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { keys, projectQuery, projectSetupQuery } from '@/lib/api/queries';
import { fieldErrorMessage } from '@/lib/forms';
import { useCan } from '@/lib/permissions';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/settings/')({
  head: () => ({ meta: [{ title: 'General · Settings · Trailmark' }] }),
  staticData: { crumb: 'General' },
  component: GeneralSettings,
});

const nameSchema = z.string().trim().min(2, 'Use at least 2 characters.').max(64, 'Keep it under 64 characters.');

function GeneralSettings() {
  const { projectId } = Route.useParams();
  const project = useQuery(projectQuery(projectId));
  if (!project.data) return <Skeleton className="h-80 w-full rounded-xl" />;
  return <GeneralForm key={project.data.id + project.data.name} project={project.data} />;
}

function GeneralForm({ project }: { project: { id: string; name: string; slug: string; description: string | null; createdAt: string } }) {
  const queryClient = useQueryClient();
  const manage = useCan()('project.update');
  const save = useMutation({
    mutationFn: (value: { name: string; description: string }) =>
      api.projects.update(project.id, { name: value.name.trim(), description: value.description.trim() || null }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.project(project.id) }),
        queryClient.invalidateQueries({ queryKey: keys.projects }),
      ]);
      toast.success('Project updated');
    },
    onError: (error) => toast.error('Could not save', { description: errorMessage(error) }),
  });
  const form = useForm({
    defaultValues: { name: project.name, description: project.description ?? '' },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value).catch(() => undefined);
    },
  });

  return (
    <div className="flex flex-col gap-5">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          form.handleSubmit();
        }}
      >
        <SettingsSection
          description="How this project appears across the console."
          footer={
            manage ? (
              <form.Subscribe selector={(s) => [s.isDirty, s.isSubmitting, s.canSubmit] as const}>
                {([dirty, submitting, canSubmit]) => (
                  <>
                    {dirty ? (
                      <Button onClick={() => form.reset()} size="sm" type="button" variant="ghost">
                        Discard
                      </Button>
                    ) : null}
                    <Button disabled={!dirty || submitting || !canSubmit} size="sm" type="submit">
                      {submitting ? <Loader2Icon className="animate-spin" /> : null}
                      Save changes
                    </Button>
                  </>
                )}
              </form.Subscribe>
            ) : undefined
          }
          title="Project"
        >
          {manage ? null : <AdminNote>Only workspace owners and admins can rename this project or change its description.</AdminNote>}
          <form.Field name="name" validators={{ onChange: nameSchema }}>
            {(field) => {
              const message = fieldErrorMessage(field.state.meta.errors);
              return (
                <div className="flex max-w-xl flex-col gap-1.5">
                  <Label htmlFor="settings-name">Name</Label>
                  <Input
                    aria-invalid={Boolean(message) || undefined}
                    disabled={!manage}
                    id="settings-name"
                    onChange={(e) => field.handleChange(e.target.value)}
                    value={field.state.value}
                  />
                  {message ? <p className="text-destructive text-xs">{message}</p> : null}
                </div>
              );
            }}
          </form.Field>
          <form.Field name="description">
            {(field) => (
              <div className="flex max-w-xl flex-col gap-1.5">
                <Label htmlFor="settings-description">Description</Label>
                <Textarea
                  className="min-h-20"
                  disabled={!manage}
                  id="settings-description"
                  maxLength={280}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="What sends events to this project?"
                  value={field.state.value}
                />
                <p className="text-muted-foreground text-xs tabular-nums">{field.state.value.length}/280</p>
              </div>
            )}
          </form.Field>
        </SettingsSection>
      </form>

      <SettingsSection description="Use these when calling the API or filing an issue." title="Identifiers">
        <dl className="grid gap-3 text-sm sm:grid-cols-[140px_1fr]">
          <dt className="text-muted-foreground">Project id</dt>
          <dd>
            <CopyValue value={project.id} />
          </dd>
          <dt className="text-muted-foreground">Slug</dt>
          <dd className="flex flex-col gap-0.5">
            <CopyValue value={project.slug} />
            <span className="text-muted-foreground text-xs">Typed to confirm destructive changes (retention, deletion).</span>
          </dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd>
            <Timestamp format="full" iso={project.createdAt} />
          </dd>
        </dl>
      </SettingsSection>

      <IntegrationGuide projectId={project.id} />
    </div>
  );
}

/** The Setup page's permanent home once the sidebar stops promoting it (setup completed at least once). */
function IntegrationGuide({ projectId }: { projectId: string }) {
  const setup = useQuery(projectSetupQuery(projectId));
  const data = setup.data;
  return (
    <SettingsSection
      description="Setup checklist, ingest snippets, the recommended event envelope, query language and keyboard shortcuts."
      title="Integration guide"
    >
      <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center" data-testid="settings-integration-guide">
        <span className="flex min-w-0 flex-1 items-center gap-3">
          {data ? (
            <ProgressRing className="shrink-0" done={data.progress.done} size={20} total={data.progress.total} />
          ) : (
            <BookOpenIcon className="size-5 shrink-0 text-muted-foreground" />
          )}
          <span className="flex min-w-0 flex-col">
            <span className="font-medium text-sm">
              {!data
                ? 'Setup'
                : data.complete
                  ? 'Setup complete'
                  : data.completedAt
                    ? `${data.progress.done} of ${data.progress.total} checks passing`
                    : `${data.progress.done} of ${data.progress.total} setup steps done`}
            </span>
            <span className="text-muted-foreground text-xs">
              {data?.completedAt ? (
                <>
                  First completed <Timestamp format="date" iso={data.completedAt} /> · checks stay live
                </>
              ) : (
                'Checked live against what this project receives.'
              )}
            </span>
          </span>
        </span>
        <Button
          className="self-start sm:self-auto"
          nativeButton={false}
          render={<Link params={{ projectId }} to="/p/$projectId/setup" />}
          size="sm"
          variant="outline"
        >
          Open integration guide
          <ArrowRightIcon />
        </Button>
      </div>
    </SettingsSection>
  );
}
