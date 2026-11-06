import { apiErrorSchema } from '@logbird/contracts';

/** Every failed API call surfaces as this error, mapped from the contract's `{ error: { code, message } }`. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  /** Seconds from the `Retry-After` header, when the server sent one. */
  readonly retryAfter: number | null;

  constructor(status: number, code: string, message: string, details?: unknown, retryAfter: number | null = null) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}

/** The client gave up waiting (see `REQUEST_DEADLINE_MS`): the server is up but not answering. */
export const TIMEOUT_CODE = 'timeout';

export const timeoutError = (what = 'Logbird') =>
  new ApiRequestError(504, TIMEOUT_CODE, `${what} did not answer in time. Check your connection, then try again.`);

/** 503s that clear on their own: a retention purge holds the project for a moment. */
const BUSY_CODES = new Set(['project_busy', 'retention_unavailable']);

export const BUSY_MESSAGE = 'This project is busy: a retention purge is running. Try again in a moment.';

export function isBusyError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 503 && BUSY_CODES.has(error.code);
}

export function isTimeoutError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.code === TIMEOUT_CODE;
}

export const FORBIDDEN_MESSAGE = 'Only workspace owners and admins can do this.';

const STATUS_MESSAGES: Record<number, string> = {
  400: 'The request was not valid.',
  401: 'Your session has expired. Sign in again.',
  403: 'You do not have access to this.',
  404: 'Not found.',
  409: 'That conflicts with something that already exists.',
  413: 'The request is too large.',
  429: 'Too many requests. Try again in a moment.',
  500: 'The server hit an unexpected error.',
  502: 'The Logbird server is not reachable.',
  503: 'The Logbird server is not available right now.',
  504: 'The Logbird server took too long to answer.',
};

/** `Retry-After` in seconds (delta form; HTTP dates are converted). */
function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

export async function toApiError(response: Response): Promise<ApiRequestError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON error bodies (proxy errors, HTML) fall back to the status message.
  }
  const retryAfter = retryAfterSeconds(response);
  const parsed = apiErrorSchema.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    const friendly = BUSY_CODES.has(code) ? BUSY_MESSAGE : response.status === 403 && code === 'forbidden' ? FORBIDDEN_MESSAGE : message;
    return new ApiRequestError(response.status, code, friendly, details, retryAfter);
  }
  return new ApiRequestError(
    response.status,
    `http_${response.status}`,
    STATUS_MESSAGES[response.status] ?? `Request failed (${response.status}).`,
    undefined,
    retryAfter,
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

/**
 * Race `promise` against a deadline. Requests the browser keeps pending forever (a starved server holds the socket
 * open) become a `timeout` error the UI can explain and retry.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, what?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(what)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
