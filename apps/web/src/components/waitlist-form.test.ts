import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { WaitlistForm } from './waitlist-form';

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
});
