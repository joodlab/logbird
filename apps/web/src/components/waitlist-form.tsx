import { Input } from '@logbird/ui/components/ui/input';
import { Label } from '@logbird/ui/components/ui/label';
import { Textarea } from '@logbird/ui/components/ui/textarea';
import { type FormEvent, type ReactNode, useState } from 'react';
import { CONTACT_EMAIL } from '../env';

// Copy: marketing/copy/contact.md (form, states).
// No mailbox is named unless WEB_CONTACT_EMAIL is configured (never a guessed address).
const mail = CONTACT_EMAIL ? (
  <a className="text-link" href={`mailto:${CONTACT_EMAIL}`}>
    {CONTACT_EMAIL}
  </a>
) : null;
export const STATUS_MESSAGES: Record<string, { tone: 'ok' | 'error'; text: ReactNode }> = {
  ok: { tone: 'ok', text: "Thanks. You're on the list, and if you asked something we'll reply by email." },
  validation_error: { tone: 'error', text: 'Something in the form needs fixing. Check the email address and try again.' },
  invalid_body: { tone: 'error', text: 'Something in the form needs fixing. Check the email address and try again.' },
  rate_limited: { tone: 'error', text: 'Too many attempts. Wait a minute, then try again.' },
  waitlist_unavailable: {
    tone: 'error',
    text: mail ? <>The form isn't available right now. Email us at {mail} instead.</> : "The form isn't available right now. Please try again later.",
  },
  error: {
    tone: 'error',
    text: mail ? (
      <>We couldn't send that. Check your connection and try again, or email {mail}.</>
    ) : (
      "We couldn't send that. Check your connection and try again."
    ),
  },
};
const messageFor = (code: string | undefined) => (code ? (STATUS_MESSAGES[code] ?? STATUS_MESSAGES.error) : undefined);

const INTERESTS = [
  { value: 'cloud', label: 'The Logbird Cloud waitlist' },
  { value: 'self-host', label: 'Self-hosting, when the source opens' },
  { value: 'updates', label: 'Product updates only' },
  { value: 'correction', label: 'A correction to one of our pages' },
  { value: 'other', label: 'A question, or support and enterprise' },
] as const;

/**
 * Progressive enhancement: a real form post that works without JavaScript (the server redirects back with
 * `?status=<code>#waitlist-<code>`, and a :target message shows), upgraded to fetch with inline field errors.
 */
export function WaitlistForm({ status, interest = 'cloud' }: { status?: string; interest?: string }) {
  const [code, setCode] = useState<string | undefined>(status);
  const [sending, setSending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setSending(true);
    setErrors({});
    setCode(undefined);
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        setCode('ok');
        form.reset();
      } else {
        setCode(body.error?.code ?? 'error');
        setErrors(body.error?.details ?? {});
      }
    } catch {
      setCode('error');
    } finally {
      setSending(false);
    }
  }
  const current = messageFor(code);
  const field = (name: string) => ({
    'aria-invalid': Boolean(errors[name]),
    'aria-describedby': errors[name] ? `${name}-error` : undefined,
  });
  const fieldError = (name: string) =>
    errors[name] ? (
      <p className="field-error" id={`${name}-error`}>
        {name === 'email' ? 'Enter a valid email address.' : errors[name].join(' ')}
      </p>
    ) : null;
  return (
    <form action="/api/waitlist" className="waitlist-form" method="post" onSubmit={submit}>
      <noscript>
        {Object.entries(STATUS_MESSAGES).map(([key, value]) => (
          <p className="native-status rounded-lg border px-4 py-3 text-sm" id={`waitlist-${key}`} key={key} tabIndex={-1}>
            {value.text}
          </p>
        ))}
      </noscript>
      <div className="form-field">
        <Label htmlFor="email">Work email</Label>
        <Input
          autoComplete="email"
          id="email"
          maxLength={254}
          name="email"
          placeholder="you@example.test"
          required
          type="email"
          {...field('email')}
        />
        <p className="text-muted-foreground text-xs">We'll only use it to contact you about Logbird.</p>
        {fieldError('email')}
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="form-field">
          <Label htmlFor="name">Name</Label>
          <Input autoComplete="name" id="name" maxLength={200} name="name" {...field('name')} />
          {fieldError('name')}
        </div>
        <div className="form-field">
          <Label htmlFor="company">Company</Label>
          <Input autoComplete="organization" id="company" maxLength={200} name="company" {...field('company')} />
          {fieldError('company')}
        </div>
      </div>
      <fieldset className="form-field">
        <legend className="mb-2 font-medium text-sm">What's this about?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {INTERESTS.map((option) => (
            <label
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm has-[:checked]:border-brand has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50"
              key={option.value}
            >
              <input className="accent-[var(--brand)]" defaultChecked={option.value === interest} name="interest" type="radio" value={option.value} />
              {option.label}
            </label>
          ))}
        </div>
        {fieldError('interest')}
      </fieldset>
      <div className="form-field">
        <Label htmlFor="message">Message</Label>
        <Textarea id="message" maxLength={2000} name="message" rows={4} {...field('message')} />
        <p className="text-muted-foreground text-xs">What are you building, and what do you need from an audit log?</p>
        {fieldError('message')}
      </div>
      <div aria-hidden="true" className="honeypot">
        <label htmlFor="website">Website</label>
        <input autoComplete="off" id="website" name="website" tabIndex={-1} />
      </div>
      <div className="flex flex-col gap-3">
        <button
          className="inline-flex h-12 items-center justify-center rounded-md bg-primary px-5 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/80 disabled:opacity-60 sm:self-start"
          disabled={sending}
          type="submit"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
        <p className="text-muted-foreground text-xs">We store your email to contact you about Logbird. No trackers.</p>
      </div>
      <div aria-atomic="true" aria-live="polite">
        {current ? (
          <p
            className={
              current.tone === 'ok'
                ? 'rounded-lg border border-outcome-success/40 px-4 py-3 text-sm'
                : 'rounded-lg border border-destructive/40 px-4 py-3 text-sm'
            }
          >
            {current.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}
