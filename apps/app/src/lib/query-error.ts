import { type QueryErrorDetails, type QueryLang, queryErrorDetailsSchema } from '@trailmark/contracts';
import { ApiRequestError } from './api/errors';

/** A search failure the query bar explains inline (instead of blanking the results). */
export interface QueryProblem {
  code: 'invalid_query' | 'sql_mode_unavailable';
  message: string;
  details: QueryErrorDetails | null;
}

const REASON_TITLES: Record<QueryErrorDetails['reason'], string> = {
  syntax: 'Syntax error',
  unknown_field: 'Unknown column',
  not_allowed: 'Not allowed',
  type: 'Type mismatch',
  too_complex: 'Query too complex',
  limit: 'Query hit a resource limit',
};

export function reasonTitle(details: QueryErrorDetails | null, code: QueryProblem['code']): string {
  if (code === 'sql_mode_unavailable') return 'SQL mode is unavailable';
  return details ? REASON_TITLES[details.reason] : 'Invalid query';
}

/** Map an API error to a QueryProblem when it is about the query itself; other failures return null. */
export function queryProblem(error: unknown, lang: QueryLang): QueryProblem | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code === 'sql_mode_unavailable') {
    return {
      code: 'sql_mode_unavailable',
      message: error.message || 'SQL mode is not configured on this server.',
      details: {
        lang: 'sql',
        reason: 'not_allowed',
        start: null,
        end: null,
        hint: 'Switch back to Query mode, or ask an admin to configure the restricted query user.',
      },
    };
  }
  if (error.code !== 'invalid_query') return null;
  const parsed = queryErrorDetailsSchema.safeParse(error.details);
  return {
    code: 'invalid_query',
    message: error.message,
    details: parsed.success ? parsed.data : { lang, reason: 'syntax', start: null, end: null, hint: null },
  };
}
