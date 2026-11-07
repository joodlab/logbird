// Test-only child process. No HTTP listener or background worker is started.
import { clickhouse } from './clickhouse';
import { ingest } from './ingest';

process.once('message', async (message) => {
  const { projectId, input, phase } = message as { projectId: string; input: unknown; phase: 'before-send' | 'after-ack' | 'rebuild-deleted' };
  const insert = clickhouse.insert.bind(clickhouse);
  if (phase === 'rebuild-deleted') {
    const command = clickhouse.command.bind(clickhouse);
    clickhouse.command = async (params) => {
      const result = await command(params);
      if (params.query.startsWith('DELETE FROM attribute_keys')) {
        process.send?.({ stage: 'deleted' });
        await new Promise(() => undefined);
      }
      return result;
    };
  }
  clickhouse.insert = async (params) => {
    if (params.table === 'events' && phase === 'before-send') {
      process.send?.({ stage: 'claimed' });
      await new Promise(() => undefined);
    }
    const result = await insert(params);
    if (params.table === 'events' && phase === 'after-ack') {
      process.send?.({ stage: 'acknowledged' });
      await new Promise(() => undefined);
    }
    return result;
  };
  try {
    await ingest(projectId, input);
    process.send?.({ stage: 'unexpected-completion' });
    process.exitCode = 1;
  } catch (error) {
    process.send?.({ stage: 'failed', name: error instanceof Error ? error.name : 'unknown' });
    process.exit(1);
  }
});
