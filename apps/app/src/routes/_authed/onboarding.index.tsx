import { Button } from '@logbird/ui/components/ui/button';
import { Input } from '@logbird/ui/components/ui/input';
import { Label } from '@logbird/ui/components/ui/label';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { ArrowRightIcon, Loader2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { api } from '@/lib/api/client';
import { authCall, authClient } from '@/lib/auth-client';
import { fieldErrorMessage } from '@/lib/forms';
import { hasName } from '@/lib/user';

export const Route = createFileRoute('/_authed/onboarding/')({
  validateSearch: z.object({ another: z.boolean().optional() }),
  beforeLoad: ({ context, search }) => {
    // OTP sign-up creates nameless users: ask for a name first so the console never shows a bare email.
    if (!hasName(context.me.user)) throw redirect({ to: '/onboarding/profile' });
    // Already in a workspace and not explicitly creating another one: continue with the project step.
    if (context.me.organizations.length > 0 && !search.another) throw redirect({ to: '/onboarding/project' });
  },
  component: WorkspaceStep,
});

/** Workspace URL slugs: unique per instance, never shown in the console (hence the random suffix on create). */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const nameSchema = z.string().trim().min(2, 'Use at least 2 characters.').max(64, 'Keep it under 64 characters.');

function WorkspaceStep() {
  const { me } = Route.useRouteContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  // Pre-fill from the email domain only when nobody at that domain has a workspace or a pending invitation yet:
  // otherwise every acme.com teammate would create another "Acme" instead of joining the existing one.
  const suggestion = useQuery({
    queryKey: ['onboarding', 'workspace-name', me.user.id],
    queryFn: ({ signal }) => api.workspaceNameSuggestion(signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const form = useForm({
    defaultValues: { name: '' },
    onSubmit: async ({ value }) => {
      setServerError(null);
      try {
        // Workspace slugs are unique across the whole instance and never shown in the console, so two
        // teams that both pick "Acme" must not collide: always add a short random suffix.
        const slug = `${slugify(value.name).slice(0, 33) || 'workspace'}-${Math.random().toString(36).slice(2, 8)}`;
        const org = await authCall(authClient.organization.create({ name: value.name.trim(), slug }));
        if (org && typeof org === 'object' && 'id' in org) {
          await authCall(authClient.organization.setActive({ organizationId: String((org as { id: string }).id) }));
        }
        // A new active workspace: drop everything cached for the previous one (project list, setup, views), like the
        // workspace switcher does, so the first-project step sees this workspace's (empty) project list.
        queryClient.clear();
        // `/` resumes at whatever is missing next (normally the project step).
        await navigate({ to: '/' });
      } catch (error) {
        setServerError(error instanceof Error ? error.message : 'Could not create the workspace.');
      }
    },
  });

  const suggested = suggestion.data?.name ?? null;
  useEffect(() => {
    if (!suggested || form.getFieldValue('name') !== '' || form.getFieldMeta('name')?.isDirty) return;
    form.setFieldValue('name', suggested, { dontUpdateMeta: true });
    // Selected, so typing the real name replaces the guess in one go.
    // The field is the only input on the page (autoFocus): focus it and select the guess once React has rendered it.
    requestAnimationFrame(() => {
      nameInput.current?.focus();
      nameInput.current?.select();
    });
  }, [suggested, form]);

  return (
    <div className="grid gap-10 md:grid-cols-[1fr_260px]">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-semibold text-2xl tracking-tight">Create your workspace</h1>
          <p className="text-muted-foreground text-sm">
            A workspace holds your team and every project that sends events. You can invite people once it exists.
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
                  <Label htmlFor="workspace-name">Workspace name</Label>
                  <Input
                    aria-describedby="workspace-help"
                    aria-invalid={Boolean(message) || undefined}
                    autoFocus
                    id="workspace-name"
                    size="lg"
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onFocus={(e) => {
                      if (suggested && e.currentTarget.value === suggested) e.currentTarget.select();
                    }}
                    placeholder="Acme Inc."
                    ref={nameInput}
                    value={field.state.value}
                  />
                  <p className="text-muted-foreground text-xs" id="workspace-help">
                    {message ? (
                      <span className="text-destructive">{message}</span>
                    ) : (
                      'Usually your company or team name. Teammates see it in their invitation.'
                    )}
                  </p>
                </div>
              );
            }}
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
                  Create workspace
                  {submitting ? null : <ArrowRightIcon />}
                </Button>
              )}
            </form.Subscribe>
            {me.organizations.length > 0 ? (
              <Button nativeButton={false} render={<Link to="/" />} variant="ghost">
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </div>
      <aside className="flex flex-col gap-3 rounded-xl border bg-card/60 p-4 text-sm shadow-xs">
        <p className="font-medium">What happens next</p>
        <ol className="flex flex-col gap-2.5 text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">1.</span> Create a project for the product that will send events.
          </li>
          <li>
            <span className="font-medium text-foreground">2.</span> Copy its ingest key and send one event with the SDK or curl.
          </li>
          <li>
            <span className="font-medium text-foreground">3.</span> Search, follow and explain every change from the console.
          </li>
        </ol>
      </aside>
    </div>
  );
}
