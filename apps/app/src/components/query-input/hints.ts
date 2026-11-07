/**
 * The syntax hint row under the query bar: one line saying what the token under the caret expects, in the
 * spirit of Datadog's search hints. Pure (no React) so it is cheap to compute on every keystroke.
 */
import { attributeKey, coreField, sqlColumn, sqlSignature } from '@/lib/query-catalog';
import type { QueryCompletion } from '@/lib/query-language';
import type { QueryFix } from '@/lib/query-lint';
import type { SqlCompletion } from '@/lib/sql-language';

export type HintPart =
  | string
  | {
      /** Inline code, syntax-highlighted in the hint's language. */
      code: string;
      /** Emphasised [start, end) slice of `code` (the current argument of a signature). */
      em?: [number, number];
    };

export interface Hint {
  /** Short label before the parts ("tenant · string"). */
  label?: string;
  parts: HintPart[];
  tone?: 'warn';
}

const c = (code: string): HintPart => ({ code });

function join(codes: string[], sep = ' '): HintPart[] {
  return codes.flatMap((x, i) => (i ? [sep, c(x)] : [c(x)]));
}

export function queryHint(context: QueryCompletion, draft: string, caret: number, fixes: QueryFix[]): Hint {
  const fix = fixes.find((f) => caret >= f.start && caret <= f.end);
  if (fix) {
    return {
      label: fix.soft ? 'Did you mean' : 'Converted when run',
      parts: [fix.message, ' → ', c(fix.replacement), fix.incomplete ? '' : ' · press → to apply'],
      tone: 'warn',
    };
  }
  switch (context.kind) {
    case 'key': {
      if (!draft.trim()) {
        return {
          parts: [
            'Type a field, a value or free text — ',
            ...join(['field:value', '-field:value', '"exact phrase"', 'a OR b', '(a OR b) c']),
            ' · Ctrl+Space shows suggestions',
          ],
        };
      }
      if (context.prefix && /^[A-Z]+$/.test(context.prefix) && context.afterTerm && 'ANDORNOT'.includes(context.prefix)) {
        return { label: 'Operator', parts: [...join(['OR', 'AND', 'NOT']), ' must be upper-case · AND binds tighter than OR'] };
      }
      if (context.prefix) {
        return {
          label: 'Field or text',
          parts: ['Pick a field to filter on, or keep typing to search ', c(context.prefix), ' in descriptions and actor, tenant and target names'],
        };
      }
      if (context.afterTerm) {
        return { label: 'Next term', parts: ['A space means AND · ', ...join(['OR', 'NOT', '-field:x', '( )'], ' · '), ' · Enter runs the query'] };
      }
      return { label: 'Term', parts: ['A field (', c('field:value'), '), free text, ', c('NOT'), ' or a group ', c('( )')] };
    }
    case 'exists':
      return { label: 'Lucene _exists_', parts: ['Written ', c('field:*'), ' here (', c('-field:*'), ' = missing); pick the field'] };
    case 'range':
      return {
        label: `${context.field} · range`,
        parts: [c('[a TO b]'), ' inclusive · ', c('{a TO b}'), ' exclusive · ', c('*'), ' leaves an end open · dates are UTC'],
      };
    case 'regex':
      return {
        label: `${context.field} · regex`,
        parts: ['RE2, matched against the whole value — ', c('/booking\\.(created|cancelled)/'), ' · escape / as \\/'],
      };
    case 'phrase':
      return { label: 'Phrase', parts: ['Searches descriptions and actor, tenant and target names, case-insensitive'] };
    case 'value': {
      const core = coreField(context.field);
      const name = core?.key ?? attributeKey(context.field);
      if (context.inGroup) {
        return { label: `${name} · any of`, parts: ['Values separated by ', c('OR'), ' — ', c(`${name}:(a OR b*)`), ' · members may end in *'] };
      }
      switch (core?.type) {
        case 'number':
          return {
            label: `${name} · number`,
            parts: context.op
              ? ['A number, e.g. ', c(`${name}:${context.op}2`)]
              : join([`${name}:>2`, `${name}:>=2`, `${name}:<5`, `${name}:[2 TO 5]`]),
          };
        case 'date':
          return {
            label: `${name} · date (UTC)`,
            parts: context.op
              ? ['YYYY-MM-DD (UTC midnight) or ISO-8601, e.g. ', c('2026-11-03T12:00:00Z')]
              : [...join([`${name}:>2026-11-01`, `${name}:[2026-11-01 TO 2026-11-03]`]), ' · the time range picker still applies'],
          };
        case 'text':
          return { label: `${name} · text`, parts: ['Words or a ', c('"quoted phrase"'), ' searched in the description'] };
        case 'array':
          return {
            label: `${name} · list`,
            parts: ['Matches when any element matches — ', ...join([`${name}:value`, `${name}:prefix*`, `${name}:*`, `${name}:(a OR b)`])],
          };
        case 'string':
          return {
            label: `${name} · ${core.suggest === 'entities' ? 'id' : 'string'}`,
            parts: [core.description, ' — ', ...join([`${name}:value`, `${name}:prefix*`, `${name}:*`, `${name}:(a OR b)`, `${name}:/re2/`])],
          };
        default:
          return {
            label: `${name} · attribute`,
            parts: [
              'Strings — ',
              ...join([`${name}:value`, `${name}:*`]),
              ' · numbers and dates with ',
              ...join([`${name}:>10`, `${name}:[1 TO 5]`]),
            ],
          };
      }
    }
    default:
      return { parts: [] };
  }
}

export function sqlHint(context: SqlCompletion, draft: string, call: { name: string; arg: number } | null): Hint {
  if (call) {
    const signature = sqlSignature(call.name);
    const open = signature.indexOf('(');
    const close = signature.lastIndexOf(')');
    if (open > 0 && close > open) {
      // Emphasise the current argument (split on top-level commas).
      const args: [number, number][] = [];
      let depth = 0;
      let start = open + 1;
      for (let i = open + 1; i < close; i += 1) {
        const ch = signature[i];
        if (ch === '(' || ch === '[') depth += 1;
        else if (ch === ')' || ch === ']') depth -= 1;
        else if (ch === ',' && depth === 0) {
          args.push([start, i]);
          start = i + 1;
        }
      }
      args.push([start, close]);
      const arg = args[Math.min(call.arg, args.length - 1)];
      const em: [number, number] | undefined = arg ? [arg[0] + (signature[arg[0]] === ' ' ? 1 : 0), arg[1]] : undefined;
      return { label: 'Function', parts: [{ code: signature, em }] };
    }
  }
  if (!draft.trim()) {
    return {
      parts: ['A ClickHouse WHERE expression — ', c("outcome = 'failure' AND job_attempt > 2"), ' · Shift+Enter adds a line · Ctrl+Space suggests'],
    };
  }
  switch (context.kind) {
    case 'ident':
      if (context.after === 'column') {
        const type = sqlColumn(context.column ?? '')?.type;
        if (type === 'array')
          return { label: `${context.column} · array`, parts: ['Use ', c(`has(${context.column}, 'value')`), ' or ', c('arrayExists(x -> …, …)')] };
        return { label: context.column, parts: ['Compare with ', ...join(['=', '!=', '>', "IN ('a', 'b')", "LIKE '%x%'", 'BETWEEN 1 AND 5'])] };
      }
      if (context.after === 'operand')
        return { label: 'Combine', parts: [...join(['AND', 'OR', 'AND NOT']), ' · wrap ORs in ( ) when mixing with AND'] };
      return { label: 'Expression', parts: ['A column, ', c("attributes['key']"), ', a function or ', c('NOT')] };
    case 'attrKey':
      return { label: 'Attribute key', parts: ['Values are strings; compare numbers with ', c("toFloat64OrNull(attributes['key']) > 5")] };
    case 'value':
      return {
        label: `${context.column === 'attributes' ? context.field.replace(/^attr\./, '') : context.column} · value`,
        parts: ['Most frequent first · quote with single quotes'],
      };
    case 'operand': {
      const type = sqlColumn(context.column)?.type;
      return {
        label: `${context.column}${type ? ` · ${type}` : ''}`,
        parts: type === 'date' ? ['e.g. ', c('now() - INTERVAL 7 DAY')] : ['A number, e.g. ', c(`${context.column} > 2`)],
      };
    }
    default:
      return { parts: [] };
  }
}
