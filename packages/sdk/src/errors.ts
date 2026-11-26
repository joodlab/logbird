export type LogbirdErrorCode =
  | 'options_invalid'
  | 'credentials_required'
  | 'client_closed'
  | 'before_send_failed'
  | 'event_invalid'
  | 'input_too_large'
  | 'input_too_deep'
  | 'event_too_large'
  | 'events_rejected'
  | 'ingest_http_error'
  | 'ingest_redirect'
  | 'ingest_unacknowledged'
  | 'ingest_request_failed'
  | 'ingest_requests_outstanding'
  | 'ingest_timeout'
  | 'shutdown_timeout'
  | 'response_too_large'
  | 'response_invalid'
  | 'read_server_only'
  | 'read_request_failed'
  | 'read_requests_outstanding'
  | 'read_http_error'
  | 'read_redirect'
  | 'read_invalid_response'
  | 'read_timeout'
  | 'read_window_unverified'
  | 'read_inexact_number'
  | 'capture_failed'
  | 'capture_incompatible_client'
  | 'capture_server_only'
  | 'capture_resolver_failed'
  | 'redaction_failed'
  | 'redaction_identifier_invalid'
  | 'redaction_options_invalid'
  | 'redaction_identifier_rule';

const messages: Record<LogbirdErrorCode, string> = {
  options_invalid: 'Invalid batching options',
  credentials_required: 'apiKey and endpoint are required when enabled',
  client_closed: 'Logbird is shut down',
  before_send_failed: 'Logbird beforeSend failed',
  event_invalid: 'Invalid Logbird event',
  input_too_large: 'Logbird event input exceeds 1 MiB',
  input_too_deep: 'Logbird event input exceeds 1,000 levels',
  event_too_large: 'Event exceeds 256 KB',
  events_rejected: 'Logbird rejected events',
  ingest_http_error: 'Logbird ingest HTTP failure',
  ingest_redirect: 'Logbird ingest redirect refused',
  ingest_unacknowledged: 'Logbird response did not acknowledge all events',
  ingest_request_failed: 'Logbird request failed',
  ingest_requests_outstanding: 'Logbird transport has too many outstanding requests',
  ingest_timeout: 'Logbird send exceeded its five-minute time limit',
  shutdown_timeout: 'Logbird shutdown time limit exceeded',
  response_too_large: 'Logbird response exceeded its byte limit',
  response_invalid: 'Invalid Logbird response',
  read_server_only: 'Logbird read keys are server-only',
  read_request_failed: 'Logbird read request failed',
  read_requests_outstanding: 'Logbird read transport has too many outstanding requests',
  read_http_error: 'Logbird read HTTP failure',
  read_redirect: 'Logbird read redirect refused',
  read_invalid_response: 'Invalid Logbird read response',
  read_timeout: 'Logbird read request timed out',
  read_window_unverified: 'Logbird read could not keep the window it was asked for',
  read_inexact_number: 'Logbird read holds a number this runtime cannot keep exactly',
  capture_failed: 'Logbird capture failed',
  capture_incompatible_client: 'The supplied Logbird client cannot prepare integration captures',
  capture_server_only: 'Logbird ingest is server-only',
  capture_resolver_failed: 'Logbird capture resolver failed',
  redaction_failed: 'Logbird redaction failed',
  redaction_identifier_invalid: 'An identifier must serialize to a scalar',
  redaction_options_invalid: 'Invalid Logbird redaction options',
  redaction_identifier_rule: 'Logbird redaction rules match protected identifiers',
};

export interface LogbirdErrorDetails {
  status?: number;
  count?: number;
}

/** SDK failures carry a stable code and approved numeric metadata. */
export class LogbirdError extends Error {
  readonly code: LogbirdErrorCode;
  readonly status?: number;
  readonly count?: number;

  constructor(code: LogbirdErrorCode, details: LogbirdErrorDetails = {}) {
    const status = Number.isInteger(details.status) && (details.status ?? 0) >= 100 && (details.status ?? 0) <= 599 ? details.status : undefined;
    const count = Number.isSafeInteger(details.count) && (details.count ?? 0) > 0 ? details.count : undefined;
    const safeCode = Object.hasOwn(messages, code) ? code : 'capture_failed';
    let message: string = messages[safeCode];
    if (safeCode === 'ingest_http_error' && status) message = `Logbird HTTP ${status}`;
    if (safeCode === 'events_rejected' && count) message = `${count} events rejected by Logbird`;
    super(message);
    this.name = 'LogbirdError';
    this.code = safeCode;
    this.status = status;
    this.count = count;
  }
}

// Reconstruct safe diagnostics even when callers or adapters use another installed copy of the SDK.
export function safeDiagnostic(error: unknown, fallback: LogbirdErrorCode): LogbirdError {
  try {
    if (error && typeof error === 'object') {
      const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
      if (typeof code === 'string' && Object.hasOwn(messages, code)) {
        const status: unknown = Object.getOwnPropertyDescriptor(error, 'status')?.value;
        const count: unknown = Object.getOwnPropertyDescriptor(error, 'count')?.value;
        return new LogbirdError(code as LogbirdErrorCode, {
          status: typeof status === 'number' ? status : undefined,
          count: typeof count === 'number' ? count : undefined,
        });
      }
    }
  } catch {
    /* A diagnostic can never surface a host error. */
  }
  return new LogbirdError(fallback);
}
