import { apiErrorSchema } from '@trailmark/contracts';

/** Every failed API call surfaces as this error, mapped from the contract's `{ error: { code, message } }`. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'The request was not valid.',
  401: 'Your session has expired. Sign in again.',
  403: 'You do not have access to this.',
  404: 'Not found.',
  409: 'That conflicts with something that already exists.',
  413: 'The request is too large.',
  429: 'Too many requests. Try again in a moment.',
  500: 'The server hit an unexpected error.',
  502: 'The Trailmark server is not reachable.',
  503: 'The Trailmark server is not available right now.',
  504: 'The Trailmark server took too long to answer.',
};

export async function toApiError(response: Response): Promise<ApiRequestError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON error bodies (proxy errors, HTML) fall back to the status message.
  }
  const parsed = apiErrorSchema.safeParse(body);
  if (parsed.success) {
    return new ApiRequestError(response.status, parsed.data.error.code, parsed.data.error.message, parsed.data.error.details);
  }
  return new ApiRequestError(response.status, `http_${response.status}`, STATUS_MESSAGES[response.status] ?? `Request failed (${response.status}).`);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
