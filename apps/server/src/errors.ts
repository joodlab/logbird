import { HTTPException } from 'hono/http-exception';
export class ApiError extends HTTPException {
  readonly code: string;
  readonly details?: unknown;
  readonly retryAfter?: number;
  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 413 | 415 | 422 | 503,
    code: string,
    message: string,
    details?: unknown,
    retryAfter?: number,
  ) {
    super(status, { message });
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}
