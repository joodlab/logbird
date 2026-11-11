export interface WaitlistRewrite {
  kept: number;
  removed: number;
  /** Lines that aren't valid JSON and were kept: the legacy file's (until its cutoff passes) or, for forget, any file's. */
  unreadable: number;
}
export function withWaitlistLock<T>(file: string, task: (path: string) => Promise<T>): Promise<T>;
export function resolveWaitlistPath(file: string): Promise<string>;
export function waitlistDays(path: string): string;
export function appendWaitlistRecord(file: string, record: unknown): Promise<void>;
export { retentionExpiry } from './expiry.mjs';
export function pruneWaitlist(file: string, now: number, months: number): Promise<WaitlistRewrite>;
export function forgetWaitlistEmail(file: string, email: string): Promise<WaitlistRewrite>;
