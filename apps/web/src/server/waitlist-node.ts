import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import nodemailer from 'nodemailer';
import { env } from '../env';
import type { WaitlistRecord } from '../lib/waitlist-schema';
export function createNodeStore(file: string, notify?: (record: WaitlistRecord) => Promise<void>) {
  return async (record: WaitlistRecord) => {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (notify) {
      await notify(record);
    }
  };
}
export async function notifyWaitlist(record: WaitlistRecord) {
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10_000,
  });
  try {
    await transport.sendMail({
      from: env.MAIL_FROM,
      to: env.WAITLIST_NOTIFY_TO,
      subject: 'Logbird waitlist submission',
      text: Object.entries(record)
        .map(([key, value]) => `${key}: ${value ?? ''}`)
        .join('\n'),
    });
  } finally {
    transport.close();
  }
}
