/**
 * ClickHouse runs `match` with RE2 (https://github.com/google/re2/wiki/Syntax). Webhook filters are checked with RE2's
 * grammar instead of JavaScript's, so a pattern only JavaScript accepts (`\cK`, lookaround, backreferences)
 * is refused at save time, and RE2 syntax JavaScript lacks (`\Q…\E`, `(?i)`, `(?P<name>…)`, `[[:alpha:]]`) is accepted.
 * The scanner refuses only constructs RE2 is known to reject. Anything it cannot decide, such as an unknown Unicode
 * class name or a program that is too large, is left to ClickHouse, whose RE2 error holds the endpoint for review.
 */
const POSIX_CLASSES = new Set([
  'alnum',
  'alpha',
  'ascii',
  'blank',
  'cntrl',
  'digit',
  'graph',
  'lower',
  'print',
  'punct',
  'space',
  'upper',
  'word',
  'xdigit',
]);
// Letters RE2 accepts after a backslash: escapes, classes, assertions, \C (any byte) and \Q…\E (literal text).
const ESCAPE_LETTERS = new Set('afntrvxpPdDsSwWbBAzCQE');
const MAX_REPEAT = 1000;
type Step = 'none' | 'atom' | 'repeat' | 'lazy';

/** Returns the index after the escape at `i`, or the reason RE2 rejects it. */
function escapeEnd(p: string, i: number): number | string {
  const next = p[i + 1];
  if (next === undefined) return 'A regex cannot end with a backslash';
  const rest = p.slice(i);
  if (/[0-7]/.test(next)) {
    // \0 and octal codes are accepted; a lone \1–\7 is a backreference, which RE2 does not support.
    const octal = /^\\(?:0[0-7]{0,2}|[1-7][0-7]{1,2})/.exec(rest);
    return octal ? i + octal[0].length : 'RE2 does not support backreferences';
  }
  if (/[89]/.test(next)) return 'RE2 does not support backreferences';
  if (next === 'x') {
    const hex = /^\\x(?:[0-9A-Fa-f]{2}|\{[0-9A-Fa-f]+\})/.exec(rest);
    return hex ? i + hex[0].length : 'Write a hex escape as \\xHH or \\x{H…}';
  }
  if (next === 'p' || next === 'P') {
    // RE2 decides whether the class name exists.
    const property = /^\\[pP](?:\{\^?[A-Za-z_]+\}|[A-Za-z])/.exec(rest);
    return property ? i + property[0].length : 'Write a Unicode class as \\pL or \\p{Name}';
  }
  if (/[A-Za-z]/.test(next) && !ESCAPE_LETTERS.has(next)) return `RE2 does not support the escape \\${next}`;
  return i + 2;
}

/** Returns the index after the character class starting at `i`, or the reason RE2 rejects it. */
function characterClass(p: string, i: number): number | string {
  let j = i + 1;
  if (p[j] === '^') j++;
  // RE2 reads a ] right after [ or [^ as a literal.
  if (p[j] === ']') j++;
  let single = false;
  while (j < p.length && p[j] !== ']') {
    if (p[j] === '[' && p[j + 1] === ':') {
      const end = p.indexOf(':]', j + 2);
      if (end >= 0) {
        if (!POSIX_CLASSES.has(p.slice(j + 2, end).replace(/^\^/, ''))) return 'Use a POSIX class RE2 supports, such as [[:alpha:]]';
        j = end + 2;
        single = false;
        continue;
      }
    }
    const rangeEnd: boolean = p[j] === '-' && single && p[j + 1] !== ']';
    if (rangeEnd) {
      // A range runs from one character to one character. RE2 rejects a shorthand class as its end.
      if (p[j + 1] === '\\' && /[dDsSwWpP]/.test(p[j + 2] ?? '')) return 'A class shorthand cannot end a range';
      j++;
    }
    if (p[j] === '\\') {
      const next = escapeEnd(p, j);
      if (typeof next === 'string') return next;
      single = !rangeEnd && !/[dDsSwWpP]/.test(p[j + 1] ?? '');
      j = next;
      continue;
    }
    single = !rangeEnd;
    j++;
  }
  return j < p.length ? j + 1 : 'Close the character class with ]';
}

/** Returns why RE2 rejects the pattern, or null when RE2 accepts it or only RE2 can decide. */
export function re2Problem(p: string): string | null {
  // RE2 limits the product of nested counted repetitions to 1000.
  const groups: number[] = [1];
  let weight = 0;
  let step: Step = 'none';
  const repeat = (c: string): string | null => {
    if (step === 'none') return 'A repetition needs something to repeat';
    if (step === 'lazy' || (step === 'repeat' && c !== '?')) return 'RE2 does not support repeating a repetition';
    step = step === 'repeat' ? 'lazy' : 'repeat';
    return null;
  };
  for (let i = 0; i < p.length; ) {
    const c = p[i];
    if (c === '\\' && p[i + 1] === 'Q') {
      // \Q…\E is literal text, up to \E or the end of the pattern.
      const end = p.indexOf('\\E', i + 2);
      i = end < 0 ? p.length : end + 2;
      weight = 1;
      step = 'atom';
    } else if (c === '\\') {
      const next = escapeEnd(p, i);
      if (typeof next === 'string') return next;
      i = next;
      weight = 1;
      step = 'atom';
    } else if (c === '[') {
      const next = characterClass(p, i);
      if (typeof next === 'string') return next;
      i = next;
      weight = 1;
      step = 'atom';
    } else if (c === '(') {
      if (p[i + 1] === '?') {
        const kind = p[i + 2] ?? '';
        // Lookaround, atomic groups, comments, branch reset and recursion are Perl and PCRE features RE2 rejects.
        if ('=!>#|&+R'.includes(kind) || /\d/.test(kind) || (kind === '<' && /[=!]/.test(p[i + 3] ?? '')))
          return 'RE2 does not support lookaround, backreferences or this group type';
      }
      groups.push(1);
      weight = 0;
      step = 'none';
      i++;
      // A group's own prefix such as ?: or ?i: is not something to repeat.
      if (p[i] === '?') {
        // RE2 decides whether a capture name is valid.
        const prefix = /^\?(?:P?<[^>]+>|[A-Za-z-]*[:)])/.exec(p.slice(i));
        if (prefix) {
          i += prefix[0].length;
          if (prefix[0].endsWith(')')) {
            // A flag group such as (?i) applies in place and closes immediately.
            groups.pop();
            step = 'atom';
            weight = 1;
          }
        }
      }
      continue;
    } else if (c === ')') {
      if (groups.length < 2) return 'Unbalanced parenthesis';
      weight = groups.pop() ?? 1;
      step = 'atom';
      i++;
    } else if (c === '|') {
      weight = 0;
      step = 'none';
      i++;
      continue;
    } else if (c === '{') {
      const counted = /^\{(\d+)(?:(,)(\d*))?\}/.exec(p.slice(i));
      if (counted) {
        const problem = repeat('{');
        if (problem) return problem;
        const min = Number(counted[1]);
        const max = counted[3] ? Number(counted[3]) : counted[2] ? -1 : min;
        if (min > MAX_REPEAT || max > MAX_REPEAT) return `RE2 repetitions are limited to ${MAX_REPEAT}`;
        if (max >= 0 && max < min) return 'A repetition range must not run backwards';
        const factor = max < 0 ? min : max;
        weight *= factor > 0 ? factor : 1;
        if (weight > MAX_REPEAT) return `RE2 limits nested repetitions to ${MAX_REPEAT} in total`;
        i += counted[0].length;
      } else {
        // RE2 reads a { that does not start a counted repetition as a literal.
        weight = 1;
        step = 'atom';
        i++;
      }
    } else if (c === '*' || c === '+' || c === '?') {
      const problem = repeat(c);
      if (problem) return problem;
      i++;
    } else {
      weight = 1;
      step = 'atom';
      i++;
    }
    groups[groups.length - 1] = Math.max(groups.at(-1) ?? 1, weight);
  }
  return groups.length === 1 ? null : 'Unbalanced parenthesis';
}
