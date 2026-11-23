/**
 * ClickHouse runs `match` with RE2, whose syntax differs from JavaScript's. JavaScript accepts constructs such as `\cK`,
 * `A` or `[]` that RE2 rejects or reads differently, so a pattern that only JavaScript accepts would fail every query.
 * This scanner accepts a conservative subset that RE2 parses. It may refuse a few rare RE2 constructs (named groups,
 * inline flags, `\Q…\E`), never the reverse. Run it after JavaScript's own parse, which catches unbalanced syntax.
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
const UNICODE_CATEGORIES = new Set(
  'Any C Cc Cf Co Cs L Ll Lm Lo Lt Lu M Mc Me Mn N Nd Nl No P Pc Pd Pe Pf Pi Po Ps S Sc Sk Sm So Z Zl Zp Zs'.split(' '),
);
// RE2 knows Unicode scripts by long name only. JavaScript also accepts the four-letter ISO 15924 aliases.
const FOUR_LETTER_SCRIPTS = new Set(['Cham', 'Kawi', 'Lisu', 'Modi', 'Newa', 'Thai', 'Toto']);
const MAX_REPEAT = 1000;

function unicodeClass(name: string) {
  if (UNICODE_CATEGORIES.has(name)) return true;
  if (!/^[A-Z][A-Za-z_]+$/.test(name) || (name.length === 4 && !FOUR_LETTER_SCRIPTS.has(name))) return false;
  try {
    return new RegExp(`\\p{Script=${name}}`, 'u').unicode;
  } catch {
    return false;
  }
}

/** Returns the index after a valid escape at `i`, or a reason RE2 would reject it. */
function escapeEnd(p: string, i: number, inClass: boolean): number | string {
  const next = p[i + 1];
  if (next === undefined) return 'A regex cannot end with a backslash';
  // RE2 accepts an escaped ASCII punctuation character as itself, but no other unknown escape.
  if (/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(next)) return i + 2;
  if ('afnrtvdDsSwW'.includes(next) || (!inClass && 'bBAz'.includes(next))) return i + 2;
  const rest = p.slice(i);
  if (next === 'x') {
    const hex = /^\\x(?:[0-9A-Fa-f]{2}|\{([0-9A-Fa-f]{1,6})\})/.exec(rest);
    if (hex && (hex[1] === undefined || Number.parseInt(hex[1], 16) <= 0x10_ff_ff)) return i + hex[0].length;
    return 'Write a hex escape as \\xHH or \\x{H…}';
  }
  if (next === '0') return i + (/^\\0[0-7]{0,2}/.exec(rest)?.[0].length ?? 2);
  if (next === 'p' || next === 'P') {
    const property = /^\\[pP](?:\{([A-Za-z_]+)\}|([CLMNPSZ]))/.exec(rest);
    if (property && unicodeClass(property[1] ?? property[2] ?? '')) return i + property[0].length;
    return 'Use a Unicode general category or script name RE2 supports, such as \\p{L} or \\p{Greek}';
  }
  return `RE2 does not support the escape \\${next}`;
}

/** Returns the index after the character class starting at `i`, or a reason RE2 would reject it. */
function characterClass(p: string, i: number): number | string {
  let j = i + 1;
  if (p[j] === '^') j++;
  // JavaScript reads [] and [^] as empty classes; RE2 reads the ] as a literal and keeps going.
  if (p[j] === ']') return 'Write ] inside a character class as \\]';
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
      const next = escapeEnd(p, j, true);
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

/** Returns why RE2 would reject the pattern, or null when the subset scanner accepts it. */
export function re2Problem(p: string): string | null {
  // RE2 limits the product of nested counted repetitions to 1000.
  const groups: number[] = [1];
  let last = 0;
  for (let i = 0; i < p.length; ) {
    const c = p[i];
    if (c === '\\') {
      const next = escapeEnd(p, i, false);
      if (typeof next === 'string') return next;
      i = next;
      last = 1;
    } else if (c === '[') {
      const next = characterClass(p, i);
      if (typeof next === 'string') return next;
      i = next;
      last = 1;
    } else if (c === '(') {
      if (p[i + 1] === '?' && p[i + 2] !== ':') return 'RE2 supports only plain (…) and non-capturing (?:…) groups here';
      i += p[i + 1] === '?' ? 3 : 1;
      groups.push(1);
      last = 0;
      continue;
    } else if (c === ')') {
      if (groups.length < 2) return 'Unbalanced parenthesis';
      last = groups.pop() ?? 1;
      i++;
    } else if (c === '|') {
      last = 0;
      i++;
      continue;
    } else if (c === '{') {
      const repeat = /^\{(\d+)(?:(,)(\d*))?\}/.exec(p.slice(i));
      if (repeat && last) {
        const min = Number(repeat[1]);
        const max = repeat[3] ? Number(repeat[3]) : repeat[2] ? -1 : min;
        if (min > MAX_REPEAT || max > MAX_REPEAT) return `RE2 repetitions are limited to ${MAX_REPEAT}`;
        const factor = max < 0 ? min : max;
        last *= factor > 0 ? factor : 1;
        if (last > MAX_REPEAT) return `RE2 limits nested repetitions to ${MAX_REPEAT} in total`;
        i += repeat[0].length;
      } else {
        last = 1;
        i++;
      }
    } else {
      // *, + and ? keep the preceding atom's weight; any other character is a literal or an anchor.
      if (c !== '*' && c !== '+' && c !== '?') last = 1;
      i++;
    }
    groups[groups.length - 1] = Math.max(groups.at(-1) ?? 1, last);
  }
  return groups.length === 1 ? null : 'Unbalanced parenthesis';
}
