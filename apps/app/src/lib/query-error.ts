import { type QueryErrorDetails, type QueryLang, queryErrorDetailsSchema } from '@logbird/contracts';
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

const excerpt = (text: string, max = 40) => {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
};

/**
 * One plain-language sentence for the problem, written for the person typing rather than the parser. Known syntax
 * slips get a concrete fix that quotes their own query ("add a closing \" after Bayt Al Rimal"); everything else falls
 * back to the server's message without its "Invalid query syntax:" prefix, and never repeats the hint twice.
 */
export function queryProblemText(problem: QueryProblem, q: string): string {
  const details = problem.details;
  const hint = details?.hint?.trim() ?? '';
  if (details?.reason === 'syntax' && details.start !== null) {
    const after = excerpt(q.slice(details.start + 1));
    if (hint === 'Unterminated quoted query')
      return after
        ? `A quote mark is missing its partner — add a closing " after ${after}.`
        : 'A quote mark is missing its partner — add a closing ".';
    if (hint === 'Unterminated regex')
      return after
        ? `A /pattern/ is missing its closing slash — add / after ${after}.`
        : 'A /pattern/ is missing its closing slash — add a closing /.';
  }
  const message = problem.message.replace(/^Invalid query syntax:\s*/i, '').trim();
  if (!hint || hint === message) return message || hint;
  if (!message || message.endsWith(hint)) return hint;
  return `${message} — ${hint}`;
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
