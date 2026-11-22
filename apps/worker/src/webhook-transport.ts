import { request as requestHttp, validateHeaderValue } from 'node:http';
import { request as requestHttps } from 'node:https';
import { resolveWebhookDestination, WebhookLookupBusyError } from '@logbird/database/webhooks';
import { signWebhook } from '@logbird/sdk';
import manifest from '../package.json' with { type: 'json' };

const CONNECT_TIMEOUT_MS = 5000;
const TOTAL_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const LOG_BYTES = 2048;
export type AttemptResult = {
  responseCode?: number;
  responseBody?: string;
  error?: 'destination_rejected' | 'timeout' | 'network_error' | 'event_unavailable' | 'invalid_event_id' | 'signing_failed';
};

export type WebhookTransportOptions = NonNullable<Parameters<typeof resolveWebhookDestination>[1]> & {
  totalTimeoutMs?: number;
};

export function usableWebhookId(id: string) {
  try {
    validateHeaderValue('webhook-id', id);
    return !!id && !id.includes('.');
  } catch {
    return false;
  }
}

export async function postWebhook(
  rawUrl: string,
  id: string,
  payload: string,
  secrets: readonly string[],
  options: WebhookTransportOptions = {},
  stillCurrent?: () => Promise<boolean>,
): Promise<AttemptResult | undefined> {
  if (!usableWebhookId(id)) return { error: 'invalid_event_id' };
  const started = Date.now();
  const signal = AbortSignal.timeout(options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);
  const timestamp = Math.floor(started / 1000);
  let signature: string;
  try {
    signature = await signWebhook({ id, timestamp, payload, secrets });
  } catch {
    return { error: 'signing_failed' };
  }
  let destination: Awaited<ReturnType<typeof resolveWebhookDestination>>;
  try {
    destination = await resolveWebhookDestination(rawUrl, options);
  } catch (error) {
    return { error: error instanceof WebhookLookupBusyError ? 'timeout' : 'destination_rejected' };
  }
  if (stillCurrent && !(await stillCurrent())) return;
  if (signal.aborted || Date.now() - started >= CONNECT_TIMEOUT_MS) return { error: 'timeout' };
  const { url, address, family } = destination;
  const https = url.protocol === 'https:';
  return new Promise((resolve) => {
    let timedOut = false;
    let responseCode: number | undefined;
    const request = (https ? requestHttps : requestHttp)(
      url,
      {
        method: 'POST',
        // A new socket for every send guarantees DNS is checked and pinned per attempt. The URL still supplies TLS
        // hostname verification, SNI and the Host header. Node's HTTP client never follows a redirect.
        agent: false,
        family,
        lookup: (_host, _options, callback) => callback(null, address, family),
        signal,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': `Logbird-Webhooks/${manifest.version}`,
          'webhook-id': id,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': signature,
        },
      },
      async (response) => {
        clearTimeout(connectTimer);
        responseCode = response.statusCode;
        const preview = Buffer.alloc(LOG_BYTES);
        let received = 0;
        try {
          for await (const chunk of response) {
            const bytes: Buffer = chunk;
            if (received < preview.length) bytes.copy(preview, received, 0, preview.length - received);
            received += Math.min(bytes.length, MAX_RESPONSE_BYTES - received);
            if (received >= MAX_RESPONSE_BYTES) break;
          }
          resolve({ responseCode: response.statusCode, responseBody: preview.subarray(0, received).toString('utf8').replaceAll('\0', '') });
        } catch {
          resolve({ error: signal.aborted ? 'timeout' : 'network_error', responseCode: response.statusCode });
        }
      },
    );
    const connectTimer = setTimeout(
      () => {
        timedOut = true;
        request.destroy(new Error('Webhook connect timeout'));
      },
      CONNECT_TIMEOUT_MS - (Date.now() - started),
    );
    request.once('socket', (socket) => socket.once(https ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer)));
    request.once('error', () => {
      clearTimeout(connectTimer);
      resolve({ error: timedOut || signal.aborted ? 'timeout' : 'network_error', responseCode });
    });
    request.end(payload);
  });
}
