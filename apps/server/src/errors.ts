import { HTTPException } from 'hono/http-exception';
export class ApiError extends HTTPException {
  readonly code: string;
  readonly details?: unknown;
  constructor(status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 503, code: string, message: string, details?: unknown) {
    super(status, { message });
    this.code = code;
    this.details = details;
  }
}
