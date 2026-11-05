/**
 * Send Trailmark's emails, rendered from the shared fixtures, through the configured SMTP server (Mailpit locally).
 *
 *   pnpm --filter @trailmark/email-preview send                       every email to preview@trailmark.local
 *   pnpm --filter @trailmark/email-preview send --to me@trailmark.local --only invitation,signInCode
 *   pnpm --filter @trailmark/email-preview send --list
 *
 * Links point at APP_URL and dates are relative to now, so what lands in the inbox is what a user would get.
 * Recipients outside test domains need --allow-external, so a production SMTP config cannot mail real people by accident.
 */
import { parseArgs } from 'node:util';
import { createFixtures, type EmailDefinition, type EmailKey, emails } from '@trailmark/email';
import { sendEmail, smtpTarget } from '@trailmark/email/send';

const SAFE_RECIPIENT = /@([\w-]+\.)*(trailmark\.local|localhost|test|example|invalid|example\.(com|net|org))$/i;

const { values } = parseArgs({
  // `pnpm … send -- --to x` forwards the separator itself; accept both spellings.
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    to: { type: 'string', default: 'preview@trailmark.local' },
    only: { type: 'string' },
    list: { type: 'boolean', default: false },
    'allow-external': { type: 'boolean', default: false },
  },
});

const keys = Object.keys(emails) as EmailKey[];
if (values.list) {
  for (const key of keys) console.log(`${key.padEnd(14)} ${emails[key].name}`);
  process.exit(0);
}

const selected = values.only ? (values.only.split(',').map((k) => k.trim()) as EmailKey[]) : keys;
const unknown = selected.filter((k) => !keys.includes(k));
if (unknown.length) {
  console.error(`Unknown email(s): ${unknown.join(', ')}. Known: ${keys.join(', ')}`);
  process.exit(1);
}
if (!(SAFE_RECIPIENT.test(values.to) || values['allow-external'])) {
  console.error(`Refusing to send to ${values.to}: not a test domain. Pass --allow-external if you really mean it.`);
  process.exit(1);
}

const target = smtpTarget();
const fixtures = createFixtures({ appUrl: target.appUrl, now: new Date() });
console.log(`SMTP ${target.host}:${target.port} · from ${target.from} · links to ${target.appUrl}\n`);
for (const key of selected) {
  const email = emails[key] as unknown as EmailDefinition<{ appUrl: string }>;
  const props = { ...fixtures[key], [email.recipient]: values.to };
  const sent = await sendEmail(email, props);
  console.log(`✓ ${key.padEnd(14)} → ${sent.to}  "${sent.subject}"  (${(Buffer.byteLength(sent.html) / 1024).toFixed(1)} KB)`);
}
const mailpit = process.env.MAILPIT_URL;
if (mailpit) {
  const url = new URL(mailpit);
  console.log(`\nInbox: ${url.protocol}//${url.host}`);
}
