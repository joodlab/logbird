export interface WaitlistRewrite {
  kept: number;
  removed: number;
  /** Lines in the legacy file that are not JSON: kept, never deleted, so an operator can deal with them. */
  unreadable: number;
}
export function withWaitlistLock<T>(file: string, task: (path: string) => Promise<T>): Promise<T>;
export function resolveWaitlistPath(file: string): Promise<string>;
export function waitlistDays(path: string): string;
export function appendWaitlistRecord(file: string, record: unknown): Promise<void>;
export { retentionExpiry } from './expiry.mjs';
export function pruneWaitlist(file: string, now: number, months: number): Promise<WaitlistRewrite>;
export function forgetWaitlistEmail(file: string, email: string): Promise<WaitlistRewrite>;
