import type { ExportStatus } from '@logbird/contracts';

/** The download headers already identify its durable outcome, even when the stream breaks. */
export async function exportFailureDescription(id: string, lookup: (signal: AbortSignal) => Promise<ExportStatus>) {
  const fallback = `Export ${id.slice(0, 8)} stopped. See Workspace activity for the reason, then retry the download.`;
  const signal = AbortSignal.timeout(2000);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = await lookup(signal);
      if (outcome.state === 'failed' || outcome.state === 'unknown') return outcome.description || fallback;
      if (outcome.state === 'completed')
        return `Export ${id.slice(0, 8)} completed on the server, but the download was interrupted. Retry the download.`;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
      signal.throwIfAborted();
    }
  } catch {
    /* The id and activity destination remain useful during an outcome-storage outage. */
  }
  return fallback;
}
