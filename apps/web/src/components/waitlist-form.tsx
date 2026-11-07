import { Button } from '@logbird/ui/components/ui/button';
import { Input } from '@logbird/ui/components/ui/input';
import { Label } from '@logbird/ui/components/ui/label';
import { Textarea } from '@logbird/ui/components/ui/textarea';
import { type FormEvent, useState } from 'react';
import { CONTACT_EMAIL } from '../env';
export function WaitlistForm({ status }: { status?: string }) {
  const [state, setState] = useState(status === 'ok' ? 'success' : status === 'error' ? 'unavailable' : 'idle');
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setState('submitting');
    setErrors({});
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const body = await response.json();
      if (response.ok) {
        setState('success');
        form.reset();
      } else {
        setState(response.status === 503 ? 'unavailable' : 'error');
        setMessage(body.error?.message ?? 'Unable to submit. Please try again.');
        setErrors(body.error?.details ?? {});
      }
    } catch {
      setState('error');
      setMessage('Unable to connect. Please try again.');
    }
  }
  return (
    <form className="waitlist-form" method="post" action="/api/waitlist" onSubmit={submit}>
      <noscript>
        <p className="native-status" id="waitlist-ok" tabIndex={-1}>
          Thank you. Your submission was received.
        </p>
        <p className="native-status" id="waitlist-error" tabIndex={-1}>
          Your submission could not be accepted. Check the fields and try again, or email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </noscript>
      {(['email', 'name', 'company'] as const).map((field) => (
        <div key={field} className="form-field">
          <Label htmlFor={field}>{field === 'email' ? 'Email (required)' : field === 'name' ? 'Name' : 'Company'}</Label>
          <Input
            id={field}
            name={field}
            type={field === 'email' ? 'email' : 'text'}
            required={field === 'email'}
            maxLength={field === 'email' ? 254 : 200}
            autoComplete={field === 'email' ? 'email' : field === 'name' ? 'name' : 'organization'}
            aria-invalid={!!errors[field]}
            aria-describedby={errors[field] ? `${field}-error` : undefined}
          />
          {errors[field] && (
            <p className="field-error" id={`${field}-error`}>
              {errors[field].join(' ')}
            </p>
          )}
        </div>
      ))}
      <div className="form-field">
        <Label htmlFor="interest">Interest</Label>
        <select
          id="interest"
          name="interest"
          className="theme-select"
          defaultValue="cloud"
          aria-invalid={!!errors.interest}
          aria-describedby={errors.interest ? 'interest-error' : undefined}
        >
          <option value="cloud">Cloud</option>
          <option value="self-host">Self-host</option>
          <option value="updates">Updates</option>
          <option value="other">Other</option>
        </select>
        {errors.interest && (
          <p id="interest-error" className="field-error">
            {errors.interest.join(' ')}
          </p>
        )}
      </div>
      <div className="form-field">
        <Label htmlFor="message">Message</Label>
        <Textarea
          id="message"
          name="message"
          maxLength={2000}
          aria-invalid={!!errors.message}
          aria-describedby={errors.message ? 'message-error' : undefined}
        />
        {errors.message && (
          <p id="message-error" className="field-error">
            {errors.message.join(' ')}
          </p>
        )}
      </div>
      <div className="honeypot" aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <Button type="submit" disabled={state === 'submitting'}>
        {state === 'submitting' ? 'Submitting…' : 'Join the waitlist'}
      </Button>
      <div aria-live="polite" aria-atomic="true">
        {state === 'success' && <p>Thank you. Your submission was received.</p>}
        {state === 'error' && <p>{message}</p>}
        {state === 'unavailable' && (
          <p>
            The waitlist isn't open on this deployment yet — email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </p>
        )}
      </div>
    </form>
  );
}
