import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { resolveWebhookDestination, WebhookLookupBusyError } from '@logbird/database/webhooks';
import manifest from '../package.json' with { type: 'json' };

const CONNECT_TIMEOUT_MS = 5000;
const TOTAL_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const LOG_BYTES = 2048;
export type AttemptResult = {
  responseCode?: number;
  responseBody?: string;
  error?: 'destination_rejected' | 'timeout' | 'network_error' | 'event_unavailable' | 'lookup_failed' | 'signing_failed';
};

export type WebhookTransportOptions = NonNullable<Parameters<typeof resolveWebhookDestination>[1]> & {
  totalTimeoutMs?: number;
};
type AttemptContext = { started: number; signal: AbortSignal; requestStarted: boolean; responseCode?: number };
type StartedRequest = { response: Promise<AttemptResult> };
type Dispatch = (startRequest: (timestamp: number, signature: string) => StartedRequest) => Promise<StartedRequest | AttemptResult | undefined>;

export function legacyWebhookHeaderId(id: string) {
  // Reserve the prefix in both branches so a literal ID can never collide with an encoded ID.
  const prefix = 'lb1_';
  return /^[\x21-\x7e]+$/.test(id) && !id.includes('.') && !id.startsWith(prefix) ? id : `${prefix}${Buffer.from(id, 'utf8').toString('base64url')}`;
}

export async function postWebhook(
  rawUrl: string,
  id: string,
  payload: string,
  dispatch: Dispatch,
  options: WebhookTransportOptions = {},
): Promise<AttemptResult | undefined> {
  const controller = new AbortController();
  const attempt: AttemptContext = { started: performance.now(), signal: controller.signal, requestStarted: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AttemptResult>((resolve) => {
    timer = setTimeout(() => {
      resolve(attempt.requestStarted ? { error: 'timeout', responseCode: attempt.responseCode } : { error: 'lookup_failed' });
      controller.abort();
    }, options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([deadline, sendWebhook(rawUrl, id, payload, dispatch, options, attempt)]);
  } finally {
    clearTimeout(timer);
  }
}

async function sendWebhook(
  rawUrl: string,
  id: string,
  payload: string,
  dispatch: Dispatch,
  options: WebhookTransportOptions,
  attempt: AttemptContext,
): Promise<AttemptResult | undefined> {
  let destination: Awaited<ReturnType<typeof resolveWebhookDestination>>;
  try {
    destination = await resolveWebhookDestination(rawUrl, options);
  } catch (error) {
    return { error: error instanceof WebhookLookupBusyError ? 'lookup_failed' : 'destination_rejected' };
  }
  if (attempt.signal.aborted) return { error: 'lookup_failed' };
  const result = await dispatch((timestamp, signature) => ({ response: startWebhook(destination, id, payload, timestamp, signature, attempt) }));
  return result && 'response' in result ? result.response : result;
}

function startWebhook(
  destination: Awaited<ReturnType<typeof resolveWebhookDestination>>,
  id: string,
  payload: string,
  timestamp: number,
  signature: string,
  attempt: AttemptContext,
): Promise<AttemptResult> {
  const { started, signal } = attempt;
  const connectTimeout = CONNECT_TIMEOUT_MS - (performance.now() - started);
  if (signal.aborted || connectTimeout <= 0) return Promise.resolve({ error: 'lookup_failed' });
  const { url, address, family } = destination;
  const https = url.protocol === 'https:';
  return new Promise((resolve) => {
    const finish = (result: AttemptResult) => {
      clearTimeout(connectTimer);
      resolve(result);
    };
    const networkFailure = () => finish({ error: signal.aborted ? 'timeout' : 'network_error', responseCode: attempt.responseCode });
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
      (response) => {
        clearTimeout(connectTimer);
        const responseCode = response.statusCode;
        attempt.responseCode = responseCode;
        const preview = Buffer.alloc(LOG_BYTES);
        let received = 0;
        const complete = () => finish({ responseCode, responseBody: preview.subarray(0, received).toString('utf8').replaceAll('\0', '') });
        response.on('data', (bytes: Buffer) => {
          if (received < preview.length) bytes.copy(preview, received, 0, preview.length - received);
          received += bytes.length;
          if (received >= MAX_RESPONSE_BYTES) {
            complete();
            response.destroy();
          }
        });
        response.once('end', complete);
        response.once('error', networkFailure);
      },
    );
    attempt.requestStarted = true;
    const connectTimer = setTimeout(() => {
      finish({ error: 'timeout' });
      request.destroy();
    }, connectTimeout);
    request.once('socket', (socket) => socket.once(https ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer)));
    request.once('upgrade', (response, socket) => {
      finish({ error: 'network_error', responseCode: response.statusCode });
      socket.destroy();
    });
    request.once('error', networkFailure);
    request.once('close', networkFailure);
    request.end(payload);
  });
}
