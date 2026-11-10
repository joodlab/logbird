import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { appendWaitlistRecord } from '../../waitlist/file.mjs';
import type { WaitlistRecord } from '../lib/waitlist-schema';
import { serverEnv as env } from './env';
/**
 * Persistence decides the response: once the JSONL line is written the submission is accepted, so a visitor is never
 * told to retry (which would duplicate their record). The email notification runs after the response, is retried with
 * backoff, and on final failure logs one line with no personal data (the record stays in the file).
 */
export function createNodeStore(
  file: string,
  notify?: (record: WaitlistRecord) => Promise<void>,
  options: { attempts?: number; delayMs?: number; log?: (line: string) => void } = {},
) {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 2000;
  const log = options.log ?? ((line: string) => console.error(line));
  const deliver = async (record: WaitlistRecord) => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await notify?.(record);
        return;
      } catch (error) {
        if (attempt === attempts) {
          // No email, name or message: only what an operator needs to look into SMTP.
          log(JSON.stringify({ level: 'error', event: 'waitlist.notify_failed', attempts, reason: error instanceof Error ? error.name : 'unknown' }));
          return;
        }
        await new Promise((done) => setTimeout(done, delayMs * 2 ** (attempt - 1)));
      }
    }
  };
  return async (record: WaitlistRecord) => {
    // Under the file's lock, so the retention cleanup or an operator's deletion never drops a new line.
    await appendWaitlistRecord(file, record);
    if (notify) {
      void deliver(record);
    }
  };
}
export async function notifyWaitlist(record: WaitlistRecord) {
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTLS: !env.SMTP_SECURE && env.SMTP_REQUIRE_TLS,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10_000,
  });
  try {
    await transport.sendMail({
      // notificationSettings() guarantees both are set before this is called.
      from: env.MAIL_FROM as string,
      to: env.WAITLIST_NOTIFY_TO as string,
      // The topic leads the subject, so privacy requests (answered within 30 days) stand out in the team mailbox.
      subject: `Logbird form: ${record.interest}`,
      text: Object.entries(record)
        .map(([key, value]) => `${key}: ${value ?? ''}`)
        .join('\n'),
    });
  } finally {
    transport.close();
  }
}

/**
 * The submissions file. An explicit WAITLIST_FILE wins; otherwise apps/web/.data/waitlist.jsonl, but only when the
 * process runs from apps/web (pnpm scripts do), so PII never lands in a directory that isn't gitignored.
 */
export function waitlistFile(configured?: string): string | undefined {
  if (configured) {
    return resolve(configured);
  }
  try {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { name?: string };
    return manifest.name === '@logbird/web' ? resolve('.data/waitlist.jsonl') : undefined;
  } catch {
    return undefined;
  }
}
