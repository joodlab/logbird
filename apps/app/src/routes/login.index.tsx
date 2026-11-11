import { Button } from '@logbird/ui/components/ui/button';
import { Input } from '@logbird/ui/components/ui/input';
import { Label } from '@logbird/ui/components/ui/label';
import { useForm } from '@tanstack/react-form';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { ArrowRightIcon, Loader2Icon, MailIcon } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { meQuery } from '@/lib/api/queries';
import { sendSignInCode } from '@/lib/auth-client';
import { changeAndRevalidate, fieldErrorMessage } from '@/lib/forms';
import type { LegalLinks } from '@/lib/legal-links';
import { getLegalLinks } from '@/lib/legal-links-fn';
import { markOtpSent } from '@/lib/otp';
import { safeRedirect } from '@/lib/session';

export const Route = createFileRoute('/login/')({
  beforeLoad: async ({ context, search }) => {
    // Already signed in? Skip the form.
    const me = await context.queryClient.fetchQuery(meQuery()).catch(() => null);
    if (me) throw redirect({ to: safeRedirect(search.redirect) });
  },
  // The operator's terms and privacy policy, from the console's runtime settings. A failure only hides the line.
  loader: (): Promise<LegalLinks> => getLegalLinks().catch(() => ({})),
  staleTime: Number.POSITIVE_INFINITY,
  component: EmailStep,
});

const emailSchema = z.email('Enter a valid email address.');

function EmailStep() {
  const navigate = useNavigate();
  const { redirect: target, email: prefill } = Route.useSearch();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm({
    defaultValues: { email: prefill ?? '' },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const email = value.email.trim().toLowerCase();
      try {
        await sendSignInCode(email);
        markOtpSent(email);
        await navigate({ to: '/login/verify', search: { email, redirect: target } });
      } catch (error) {
        setServerError(error instanceof Error ? error.message : 'Could not send the code. Try again.');
      }
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-2xl tracking-tight">Sign in to Logbird</h1>
        <p className="text-muted-foreground text-sm">We will email you a 6-digit code. New here? The same step creates your account.</p>
      </div>
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          form.handleSubmit();
        }}
      >
        <form.Field name="email" validators={{ onSubmit: emailSchema, onBlur: emailSchema }}>
          {(field) => {
            const message = fieldErrorMessage(field.state.meta.errors);
            return (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={field.name}>Work email</Label>
                <div className="relative">
                  <MailIcon className="-translate-y-1/2 pointer-events-none absolute start-3 top-1/2 size-4 text-muted-foreground" />
                  <Input
                    aria-describedby={message ? 'email-error' : undefined}
                    aria-invalid={Boolean(message) || undefined}
                    autoComplete="email"
                    autoFocus
                    className="ps-9"
                    size="lg"
                    id={field.name}
                    inputMode="email"
                    name={field.name}
                    onBlur={field.handleBlur}
                    onChange={(e) => changeAndRevalidate(field, e.target.value)}
                    placeholder="you@company.com"
                    type="email"
                    value={field.state.value}
                  />
                </div>
                {message ? (
                  <p className="text-destructive text-xs" id="email-error">
                    {message}
                  </p>
                ) : null}
              </div>
            );
          }}
        </form.Field>
        {serverError ? (
          <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-sm" role="alert">
            {serverError}
          </p>
        ) : null}
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(submitting) => (
            <Button size="lg" disabled={submitting} type="submit">
              {submitting ? <Loader2Icon className="animate-spin" /> : null}
              {submitting ? 'Sending code…' : serverError ? 'Try again' : 'Continue with email'}
              {submitting ? null : <ArrowRightIcon />}
            </Button>
          )}
        </form.Subscribe>
      </form>
      <LegalNotice links={Route.useLoaderData()} />
      {import.meta.env.DEV ? (
        <p className="text-muted-foreground text-xs leading-relaxed">
          Local development: codes land in Mailpit at <span className="font-mono">127.0.0.1:8025</span>.
        </p>
      ) : null}
    </div>
  );
}

const legalLink = 'text-foreground underline underline-offset-2 hover:text-foreground/80';

/** "By continuing…" with whichever of the terms and privacy policy the operator publishes; nothing when neither. */
function LegalNotice({ links }: { links: LegalLinks }) {
  const terms = links.terms ? (
    <a className={legalLink} href={links.terms} rel="noreferrer" target="_blank">
      Terms
    </a>
  ) : null;
  const privacy = links.privacy ? (
    <a className={legalLink} href={links.privacy} rel="noreferrer" target="_blank">
      Privacy policy
    </a>
  ) : null;
  if (!(terms || privacy)) return null;
  return (
    <p className="text-muted-foreground text-xs leading-relaxed" data-testid="legal-notice">
      {terms && privacy ? (
        <>
          By continuing you agree to the {terms} and acknowledge the {privacy}.
        </>
      ) : terms ? (
        <>By continuing you agree to the {terms}.</>
      ) : (
        <>See the {privacy} for how your data is handled.</>
      )}
    </p>
  );
}
