import { Input } from '@logbird/ui/components/ui/input';
import { Label } from '@logbird/ui/components/ui/label';
import { Textarea } from '@logbird/ui/components/ui/textarea';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { type AroundMail, INTERESTS, waitlistForm as words } from '../content/waitlist-form';
import { NEEDS, VOLUMES } from '../lib/waitlist-schema';

// Words: content/waitlist-form.ts (the page around the form renders content/contact.ts). Brief: marketing/copy/contact.md.
const mail = words.mail ? (
  <a className="text-link" href={words.mail.href}>
    {words.mail.label}
  </a>
) : null;
/** A status message, with the contact mailbox linked where the words leave room for it. */
const withMail = (text: string | AroundMail): ReactNode =>
  typeof text === 'string' ? (
    text
  ) : (
    <>
      {text.before}
      {mail}
      {text.after}
    </>
  );
export const STATUS_MESSAGES: Record<string, { tone: 'ok' | 'error'; text: ReactNode }> = Object.fromEntries(
  Object.entries(words.status).map(([code, text]) => [code, { tone: code === 'ok' ? 'ok' : 'error', text: withMail(text) }]),
);
const messageFor = (code: string | undefined) => (code ? (STATUS_MESSAGES[code] ?? STATUS_MESSAGES.error) : undefined);

/**
 * Progressive enhancement: a real form post that works without JavaScript (the server redirects back with
 * `?status=<code>#waitlist-<code>`, and a :target message shows), upgraded to fetch with inline field errors.
 */
// Optional qualifying questions. Values: lib/waitlist-schema.ts (VOLUMES, NEEDS), in that order.
const VOLUME_OPTIONS = VOLUMES.map((value) => ({ value, label: words.volumes[value] }));
const NEED_OPTIONS = NEEDS.map((value) => ({ value, label: words.needs[value] }));
const INTEREST_OPTIONS = INTERESTS.map((value) => ({ value, label: words.interests[value] }));
/** The form as JSON: every field once, except the repeated `needs` checkboxes, sent as a list. */
export const formFields = (data: FormData) => ({ ...Object.fromEntries(data), needs: data.getAll('needs') });

export function WaitlistForm({ status, interest = 'cloud' }: { status?: string; interest?: string }) {
  // The page is prerendered once, without its query string, and hydrated at `?status=…` or `?interest=…`. The first
  // render must match that static HTML (no message, "cloud" checked), so both are applied after mount.
  const [code, setCode] = useState<string | undefined>();
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (status) {
      setCode(status);
    }
  }, [status]);
  // Selects the URL's interest; also after a successful send, when form.reset() would fall back to "cloud".
  const selectInterest = (form: HTMLFormElement | null) => {
    const radio = form?.querySelector<HTMLInputElement>(`input[name="interest"][value="${CSS.escape(interest)}"]`);
    if (radio) {
      radio.checked = true;
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectInterest only reads `interest`, listed here
  useEffect(() => selectInterest(formRef.current), [interest]);
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
        body: JSON.stringify(formFields(new FormData(form))),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        setCode('ok');
        form.reset();
        selectInterest(form);
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
        {name === 'email' ? words.emailInvalid : errors[name].join(' ')}
      </p>
    ) : null;
  return (
    <form action="/site-api/waitlist" className="waitlist-form" method="post" onSubmit={submit} ref={formRef}>
      <noscript>
        {Object.entries(STATUS_MESSAGES).map(([key, value]) => (
          <p className="native-status rounded-lg border px-4 py-3 text-sm" id={`waitlist-${key}`} key={key} tabIndex={-1}>
            {value.text}
          </p>
        ))}
      </noscript>
      <div className="form-field">
        <Label htmlFor="email">{words.labels.email}</Label>
        <Input
          autoComplete="email"
          id="email"
          maxLength={254}
          name="email"
          placeholder={words.emailPlaceholder}
          required
          type="email"
          {...field('email')}
        />
        {fieldError('email')}
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="form-field">
          <Label htmlFor="name">{words.labels.name}</Label>
          <Input autoComplete="name" id="name" maxLength={200} name="name" {...field('name')} />
          {fieldError('name')}
        </div>
        <div className="form-field">
          <Label htmlFor="company">{words.labels.company}</Label>
          <Input autoComplete="organization" id="company" maxLength={200} name="company" {...field('company')} />
          {fieldError('company')}
        </div>
      </div>
      <fieldset className="form-field">
        <legend className="mb-2 font-medium text-sm">{words.labels.interest}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {INTEREST_OPTIONS.map((option) => (
            <label
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm has-[:checked]:border-brand has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50"
              key={option.value}
            >
              <input className="accent-[var(--brand)]" defaultChecked={option.value === 'cloud'} name="interest" type="radio" value={option.value} />
              {option.label}
            </label>
          ))}
        </div>
        {fieldError('interest')}
      </fieldset>
      <div className="form-field">
        <Label htmlFor="volume">{words.labels.volume}</Label>
        <select
          className="h-10 rounded-md border bg-background px-3 text-sm sm:max-w-xs"
          defaultValue=""
          id="volume"
          name="volume"
          {...field('volume')}
        >
          <option value="">{words.labels.volumeNone}</option>
          {VOLUME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {fieldError('volume')}
      </div>
      <fieldset className="form-field">
        <legend className="mb-2 font-medium text-sm">{words.labels.needs}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {NEED_OPTIONS.map((option) => (
            <label
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm has-[:checked]:border-brand has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50"
              key={option.value}
            >
              <input className="accent-[var(--brand)]" name="needs" type="checkbox" value={option.value} {...field('needs')} />
              {option.label}
            </label>
          ))}
        </div>
        {fieldError('needs')}
      </fieldset>
      <div className="form-field">
        <Label htmlFor="message">{words.labels.message}</Label>
        <Textarea id="message" maxLength={2000} name="message" rows={4} {...field('message')} />
        <p className="text-muted-foreground text-xs">{words.messageHint}</p>
        {fieldError('message')}
      </div>
      <div aria-hidden="true" className="honeypot">
        <label htmlFor="website">{words.labels.website}</label>
        <input autoComplete="off" id="website" name="website" tabIndex={-1} />
      </div>
      <div className="flex flex-col gap-3">
        <button
          aria-describedby="form-privacy"
          className="inline-flex h-12 items-center justify-center rounded-md bg-primary px-5 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/80 disabled:opacity-60 sm:self-start"
          disabled={sending}
          type="submit"
        >
          {sending ? words.submit.sending : words.submit.idle}
        </button>
        <p className="text-muted-foreground text-xs" id="form-privacy">
          {words.consent.before}{' '}
          <a className="text-link" href="/legal/privacy">
            {words.consent.link}
          </a>
          {words.consent.after}
        </p>
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
