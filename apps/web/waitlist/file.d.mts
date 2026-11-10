export interface WaitlistRewrite {
  kept: number;
  removed: number;
}
export function withWaitlistLock<T>(file: string, task: () => Promise<T>): Promise<T>;
export function appendWaitlistRecord(file: string, record: unknown): Promise<void>;
export function rewriteWaitlist(file: string, keep: (record: unknown) => boolean): Promise<WaitlistRewrite>;
export function retentionCutoff(now: number | Date, months: number): string;
export function pruneWaitlist(file: string, cutoff: string): Promise<WaitlistRewrite>;
export function forgetWaitlistEmail(file: string, email: string): Promise<WaitlistRewrite>;
