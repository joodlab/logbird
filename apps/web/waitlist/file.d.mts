export interface WaitlistRewrite {
  kept: number;
  removed: number;
}
export function withWaitlistLock<T>(file: string, task: (path: string) => Promise<T>): Promise<T>;
export function appendWaitlistRecord(file: string, record: unknown): Promise<void>;
export function rewriteWaitlist(file: string, keep: (record: unknown) => boolean): Promise<WaitlistRewrite>;
export { retentionExpiry } from './expiry.mjs';
export function pruneWaitlist(file: string, now: number, months: number): Promise<WaitlistRewrite>;
export function forgetWaitlistEmail(file: string, email: string): Promise<WaitlistRewrite>;
export function resolveWaitlistPath(file: string): Promise<string>;
