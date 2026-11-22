import type { ClickHouseClient } from '@logbird/clickhouse';
import { webhookSecretKey } from '@logbird/database/webhooks';
import { Queue, Worker } from 'bullmq';
import { env } from './env';
import { connection } from './queue';
import { deliverWebhooks } from './webhook-delivery';
import { scanWebhooks } from './webhook-discovery';
import { sendWebhookDisableNotices } from './webhook-notices';
import { pruneWebhookLogs } from './webhook-retention';

export async function startWebhookQueues(ch: ClickHouseClient) {
  const key = env.BETTER_AUTH_SECRET || env.WEBHOOK_SECRET_KEY ? webhookSecretKey(env.BETTER_AUTH_SECRET ?? '', env.WEBHOOK_SECRET_KEY) : null;
  if (!key) console.warn(JSON.stringify({ event: 'webhook.delivery_key_missing' }));
  const options = { connection, prefix: env.BULLMQ_PREFIX };
  const jobs = [
    { name: 'webhook-discovery', interval: 2000, run: () => scanWebhooks(ch) },
    {
      name: 'webhook-delivery',
      interval: 1000,
      run: async () => {
        if (key)
          await deliverWebhooks(ch, {
            secretKey: key,
            concurrency: env.WEBHOOKS_WORKER_CONCURRENCY,
            perEndpoint: env.WEBHOOKS_ENDPOINT_CONCURRENCY,
            failureLimit: env.WEBHOOKS_FAILURE_LIMIT,
            transport: { allowHttp: env.WEBHOOKS_ALLOW_HTTP },
          });
      },
    },
    { name: 'webhook-notices', interval: 30_000, run: () => sendWebhookDisableNotices() },
    { name: 'webhook-retention', interval: 60_000, run: () => pruneWebhookLogs() },
  ];
  const close: (() => Promise<void>)[] = [];
  for (const { name, interval, run } of jobs) {
    const queue = new Queue(name, { ...options, defaultJobOptions: { removeOnComplete: 10, removeOnFail: 20 } });
    await queue.setGlobalConcurrency(1);
    const worker = new Worker(name, run, { ...options, concurrency: 1 });
    worker.on('error', () => console.error(JSON.stringify({ event: 'webhook.worker_error', queue: name })));
    worker.on('failed', () => console.error(JSON.stringify({ event: 'webhook.job_failed', queue: name })));
    await queue.upsertJobScheduler(name, { every: interval }, { name, data: {} });
    close.push(async () => {
      await worker.close();
      await queue.close();
    });
  }
  return () => Promise.all(close.map((stop) => stop()));
}
