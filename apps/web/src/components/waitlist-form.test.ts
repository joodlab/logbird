import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { NEEDS, VOLUMES } from '../lib/waitlist-schema';
import { formFields, WaitlistForm } from './waitlist-form';

it('renders a native form and static no-JS feedback targets', () => {
  const html = renderToStaticMarkup(createElement(WaitlistForm));
  expect(html).toContain('method="post"');
  expect(html).toContain('action="/site-api/waitlist"');
  expect(html).toContain('<noscript>');
  expect(html).toContain('id="waitlist-ok"');
  expect(html).toContain('id="waitlist-error"');
  expect(html).toContain('id="waitlist-validation_error"');
  expect(html).toContain('id="waitlist-waitlist_unavailable"');
  expect(html).toContain('name="email"');
  expect(html).toContain('name="website"');
  expect(html).toContain('aria-live="polite"');
  // The privacy policy is one click away, the submit button is described by the consent line, and rights requests
  // have their own topic while no privacy mailbox is configured.
  expect(html).toContain('href="/legal/privacy"');
  expect(html).toContain('aria-describedby="form-privacy"');
  expect(html).toContain('value="privacy"');
});

it('offers the optional qualifying questions with every stored value, and sends ticked needs as a list', () => {
  const html = renderToStaticMarkup(createElement(WaitlistForm));
  expect(html).toContain('name="volume"');
  for (const value of VOLUMES) expect(html).toContain(`value="${value}"`);
  const checkboxes = [...html.matchAll(/<input[^>]*>/g)].map(([tag]) => tag).filter((tag) => tag.includes('name="needs"'));
  expect(checkboxes.every((tag) => tag.includes('type="checkbox"'))).toBe(true);
  expect(checkboxes.map((tag) => /value="([^"]*)"/.exec(tag)?.[1])).toEqual([...NEEDS]);
  const data = new FormData();
  data.append('email', 'test-waitlist@example.test');
  data.append('needs', 'compliance');
  data.append('needs', 'other');
  expect(formFields(data)).toEqual({ email: 'test-waitlist@example.test', needs: ['compliance', 'other'] });
  expect(formFields(new FormData()).needs).toEqual([]);
});
