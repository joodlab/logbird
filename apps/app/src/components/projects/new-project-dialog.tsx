import { Button } from '@logbird/ui/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@logbird/ui/components/ui/dialog';
import { Input } from '@logbird/ui/components/ui/input';
import { Label } from '@logbird/ui/components/ui/label';
import { Textarea } from '@logbird/ui/components/ui/textarea';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Loader2Icon } from 'lucide-react';
import { type RefObject, useId, useRef } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { PendingHint } from '@/components/pending-hint';
import { RetentionPicker } from '@/components/retention-picker';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { keys } from '@/lib/api/queries';
import { formatRetention } from '@/lib/format';
import { fieldErrorMessage } from '@/lib/forms';
import { ingestSecretId, stashSecret } from '@/lib/one-time-secrets';

const nameSchema = z.string().trim().min(2, 'Use at least 2 characters.').max(64, 'Keep it under 64 characters.');

/**
 * "New project" for people who already use Logbird: a dialog inside the app shell (name, description, retention) that
 * lands on the new project's Setup page, which shows the initial ingest key once and the first-event panel. The
 * full-screen onboarding wizard stays for a workspace's very first project.
 */
export function NewProjectDialog({
  open,
  onOpenChange,
  workspaceName,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceName?: string;
  /** Where focus returns when the dialog was opened from state (menu item) rather than a trigger. */
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const nameInput = useRef<HTMLInputElement>(null);
  const retentionLabel = useId();
  const create = useMutation({
    mutationFn: (value: { name: string; description: string; retentionDays: number }) =>
      api.projects.create({ name: value.name.trim(), description: value.description.trim() || undefined, retentionDays: value.retentionDays }),
    onSuccess: async (result) => {
      // The initial ingest key is shown once, on the Setup page this lands on.
      stashSecret(ingestSecretId(result.project.id), result.ingestKey.secret);
      await queryClient.invalidateQueries({ queryKey: keys.projects });
      close(false);
      toast.success(`Created ${result.project.name}`, { description: 'Copy its ingest key below — it is shown only once.' });
      await navigate({ to: '/p/$projectId/setup', params: { projectId: result.project.id } });
    },
  });
  const form = useForm({
    defaultValues: { name: '', description: '', retentionDays: 90 },
    onSubmit: ({ value }) => create.mutateAsync(value).catch(() => undefined),
  });
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      form.reset();
      create.reset();
    }
  };

  return (
    <Dialog onOpenChange={(next) => (create.isPending ? undefined : close(next))} open={open}>
      <DialogContent className="sm:max-w-lg" data-testid="new-project-dialog" finalFocus={finalFocus} initialFocus={nameInput}>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              One project per product or environment family{workspaceName ? ` in ${workspaceName}` : ''}. It gets its own ingest key, retention and
              saved views.
            </DialogDescription>
          </DialogHeader>
          <form.Field name="name" validators={{ onSubmit: nameSchema }}>
            {(field) => {
              const message = fieldErrorMessage(field.state.meta.errors);
              return (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="new-project-name">Name</Label>
                  <Input
                    aria-invalid={Boolean(message) || undefined}
                    id="new-project-name"
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="Storefront API"
                    ref={nameInput}
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
                <Label htmlFor="new-project-description">
                  Description <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Textarea
                  className="min-h-16"
                  id="new-project-description"
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
                  <Label id={retentionLabel}>Retention</Label>
                  <p className="text-muted-foreground text-xs">
                    Events older than {formatRetention(field.state.value)} are permanently deleted. You can change this later in Settings.
                  </p>
                </div>
                <RetentionPicker aria-labelledby={retentionLabel} onChange={field.handleChange} value={field.state.value} />
              </div>
            )}
          </form.Field>
          {create.isError ? (
            <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-sm" role="alert">
              {errorMessage(create.error)}
            </p>
          ) : null}
          <PendingHint
            pending={create.isPending}
            slow="Creating the project and its ingest key…"
            slower="Still working — this rarely takes this long."
          />
          <DialogFooter>
            <Button disabled={create.isPending} onClick={() => close(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={create.isPending} type="submit">
              {create.isPending ? <Loader2Icon className="animate-spin" /> : null}
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
