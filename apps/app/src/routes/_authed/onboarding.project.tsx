import { useForm } from '@tanstack/react-form';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { Button } from '@trailmark/ui/components/ui/button';
import { Input } from '@trailmark/ui/components/ui/input';
import { Label } from '@trailmark/ui/components/ui/label';
import { Textarea } from '@trailmark/ui/components/ui/textarea';
import { ArrowRightIcon, Loader2Icon } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { RetentionPicker } from '@/components/retention-picker';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { keys } from '@/lib/api/queries';
import { formatRetention } from '@/lib/format';
import { fieldErrorMessage } from '@/lib/forms';
import { stashSecret } from '@/lib/one-time-secrets';
import { ensureActiveWorkspace } from '@/lib/session';

export const Route = createFileRoute('/_authed/onboarding/project')({
  beforeLoad: async ({ context }) => {
    if (context.me.organizations.length === 0) throw redirect({ to: '/onboarding' });
    // Project creation is scoped to the session's active workspace.
    return { me: await ensureActiveWorkspace(context.queryClient, context.me) };
  },
  component: ProjectStep,
});

const nameSchema = z.string().trim().min(2, 'Use at least 2 characters.').max(64, 'Keep it under 64 characters.');

function ProjectStep() {
  const { me } = Route.useRouteContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const workspace = me.organizations.find((o) => o.id === me.activeOrganizationId) ?? me.organizations[0];
  const form = useForm({
    defaultValues: { name: '', description: '', retentionDays: 90 },
    onSubmit: async ({ value }) => {
      setServerError(null);
      try {
        const result = await api.projects.create({
          name: value.name.trim(),
          description: value.description.trim() || undefined,
          retentionDays: value.retentionDays,
        });
        stashSecret(result.project.id, result.ingestKey.secret);
        await queryClient.invalidateQueries({ queryKey: keys.projects });
        await navigate({ to: '/onboarding/first-event/$projectId', params: { projectId: result.project.id } });
      } catch (error) {
        setServerError(errorMessage(error));
      }
    },
  });

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-2xl tracking-tight">Create a project</h1>
        <p className="text-muted-foreground text-sm">
          One project per product or environment family. Events, API keys and retention live on the project
          {workspace ? (
            <>
              {' '}
              in <span className="font-medium text-foreground">{workspace.name}</span>
            </>
          ) : null}
          .
        </p>
      </div>
      <form
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          form.handleSubmit();
        }}
      >
        <form.Field name="name" validators={{ onSubmit: nameSchema, onChange: nameSchema }}>
          {(field) => {
            const message = field.state.meta.isTouched ? fieldErrorMessage(field.state.meta.errors) : undefined;
            return (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="project-name">Project name</Label>
                <Input
                  aria-invalid={Boolean(message) || undefined}
                  autoFocus
                  id="project-name"
                  size="lg"
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="Storefront API"
                  value={field.state.value}
                />
                {message ? <p className="text-destructive text-xs">{message}</p> : null}
              </div>
            );
          }}
        </form.Field>
        <form.Field name="description">
          {(field) => (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="project-description">
                Description <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                className="min-h-16"
                id="project-description"
                maxLength={280}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="What sends events here?"
                value={field.state.value}
              />
            </div>
          )}
        </form.Field>
        <form.Field name="retentionDays">
          {(field) => (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <Label>Retention</Label>
                <p className="text-muted-foreground text-xs">
                  Events older than {formatRetention(field.state.value)} are permanently deleted. You can change this later in Settings.
                </p>
              </div>
              <RetentionPicker onChange={field.handleChange} value={field.state.value} />
            </div>
          )}
        </form.Field>
        {serverError ? (
          <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-sm" role="alert">
            {serverError}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <form.Subscribe selector={(s) => [s.isSubmitting, s.canSubmit] as const}>
            {([submitting, canSubmit]) => (
              <Button size="lg" disabled={submitting || !canSubmit} type="submit">
                {submitting ? <Loader2Icon className="animate-spin" /> : null}
                Create project
                {submitting ? null : <ArrowRightIcon />}
              </Button>
            )}
          </form.Subscribe>
          <Button nativeButton={false} render={<Link search={{ another: true }} to="/onboarding" />} variant="ghost">
            New workspace instead
          </Button>
        </div>
      </form>
    </div>
  );
}
