import { useForm } from '@tanstack/react-form';
import { useQueryClient } from '@tanstack/react-query';
import { Input } from '@trailmark/ui/components/ui/input';
import { Label } from '@trailmark/ui/components/ui/label';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { z } from 'zod';
import { meQuery } from '@/lib/api/queries';
import { authCall, authClient } from '@/lib/auth-client';
import { fieldErrorMessage } from '@/lib/forms';

export const personNameSchema = z.string().trim().min(1, 'Enter your name.').max(64, 'Keep it under 64 characters.');

/** Saves the display name through better-auth `updateUser`, then refreshes `me` so the sidebar and avatar update. */
export function useSaveName() {
  const queryClient = useQueryClient();
  return async (name: string) => {
    await authCall(authClient.updateUser({ name: name.trim() }));
    await queryClient.invalidateQueries({ queryKey: meQuery().queryKey });
  };
}

/**
 * The display-name field shared by onboarding ("You") and account settings. Render-prop `actions` receives the
 * form state so each surface can place its own buttons.
 */
export function NameForm({
  initial,
  onSaved,
  autoFocus,
  actions,
  inputClassName,
  onChange,
}: {
  initial: string;
  /** Live value, e.g. for an avatar preview. */
  onChange?: (name: string) => void;
  onSaved?: (name: string) => Promise<void> | void;
  autoFocus?: boolean;
  inputClassName?: string;
  actions: (state: { dirty: boolean; submitting: boolean; canSubmit: boolean; reset: () => void }) => ReactNode;
}) {
  const save = useSaveName();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm({
    defaultValues: { name: initial },
    onSubmit: async ({ value, formApi }) => {
      setServerError(null);
      try {
        await save(value.name);
        formApi.reset({ name: value.name.trim() });
        await onSaved?.(value.name.trim());
      } catch (error) {
        setServerError(error instanceof Error ? error.message : 'Could not save your name.');
      }
    },
  });
  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <form.Field name="name" validators={{ onSubmit: personNameSchema, onChange: personNameSchema }}>
        {(field) => {
          const message = field.state.meta.isTouched ? fieldErrorMessage(field.state.meta.errors) : undefined;
          return (
            <div className="flex max-w-md flex-col gap-1.5">
              <Label htmlFor="person-name">Your name</Label>
              <Input
                aria-describedby="person-name-help"
                aria-invalid={Boolean(message) || undefined}
                autoComplete="name"
                autoFocus={autoFocus}
                className={inputClassName}
                dir="auto"
                id="person-name"
                onBlur={field.handleBlur}
                onChange={(e) => {
                  field.handleChange(e.target.value);
                  onChange?.(e.target.value);
                }}
                placeholder="Lina Haddad"
                value={field.state.value}
              />
              <p className="text-muted-foreground text-xs" id="person-name-help">
                {message ? (
                  <span className="text-destructive">{message}</span>
                ) : (
                  'Shown to your teammates, in member lists and in workspace activity.'
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
      <form.Subscribe selector={(s) => [s.isDirty, s.isSubmitting, s.canSubmit] as const}>
        {([dirty, submitting, canSubmit]) => actions({ dirty, submitting, canSubmit, reset: () => form.reset() })}
      </form.Subscribe>
    </form>
  );
}
