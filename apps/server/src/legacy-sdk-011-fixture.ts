import type { EventInput, LogbirdOptions } from '../../../packages/sdk/src/index';

/**
 * Compatibility fixture. send() is copied verbatim from
 * git show v0.1.1:packages/sdk/src/index.ts (including its historical SDK header).
 * The small queue harness accepts already-prepared events; flush requeues a failed batch just as 0.1.1 did.
 * In particular, 503 details are ignored and every retry sends the identical body.
 */
export class LegacySdk011Fixture {
  private readonly queue: EventInput[] = [];
  private readonly retries: number;
  private pending: Promise<void> | undefined;
  constructor(private readonly options: LogbirdOptions) {
    this.retries = options.maxRetries ?? 5;
  }
  get queueSize() {
    return this.queue.length;
  }
  track(event: EventInput) {
    this.queue.push(event);
  }
  private drop(event: EventInput) {
    this.options.onDrop?.(event);
  }
  private report(error: Error) {
    this.options.onError?.(error);
  }
  private async send(batch: EventInput[]) {
    const body = JSON.stringify({ events: batch });
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined, error: unknown;
      try {
        response = await fetch(`${this.options.endpoint!.replace(/\/$/, '')}/v1/events`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json', 'X-Logbird-SDK': 'typescript/0.2.0' },
          body,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        error = e;
      }
      if (response?.ok) {
        const result = (await response.json()) as { rejected?: { index: number; reason: string }[] };
        if (result.rejected?.length) {
          for (const rejection of result.rejected) {
            const event = batch[rejection.index];
            if (event) this.drop(event);
          }
          this.report(new Error(`${result.rejected.length} events rejected by Logbird: ${result.rejected.map((r) => r.reason).join('; ')}`));
        }
        return;
      }
      const retry = !response || response.status === 429 || response.status >= 500;
      if (!retry) {
        for (const event of batch) this.drop(event);
        this.report(new Error(`Logbird HTTP ${response?.status}; batch dropped`));
        return;
      }
      if (attempt >= this.retries) throw error ?? new Error(`Logbird HTTP ${response?.status}`);
      const retryAfter = response?.headers.get('Retry-After');
      const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Math.min(30_000, 250 * 2 ** attempt) * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(60_000, delay))));
    }
  }
  flush(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, 1000);
        try {
          await this.send(batch);
        } catch (error) {
          this.queue.unshift(...batch);
          throw error;
        }
      }
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
}
