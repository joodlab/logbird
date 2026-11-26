import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  isTrailQueryError,
  readAuditTrail,
  SERVER_DEFAULT_RANGE,
  type SearchInput,
  searchKey,
  snapshotSearchQuery,
  snapshotTrail,
  type TrailInput,
  type TrailQuery,
  TrailQueryError,
  trailQuery as trailQueryStrict,
} from './read';

/**
 * These tests are about selectors and the input boundary, not the window: a trail that names no `range` gets the
 * explicit default window through its prototype, so getters, Proxies and read counts behave exactly as given.
 * read-window.test.ts covers the window rule itself.
 */
const trailQuery = (input: TrailInput) =>
  trailQueryStrict(
    input !== null && typeof input === 'object' && !('range' in input)
      ? (Object.create(input, { range: { value: SERVER_DEFAULT_RANGE, enumerable: true } }) as TrailQuery)
      : (input as TrailQuery),
  );

// #311: every public read entry point first copies its input into a plain frozen snapshot of primitives, reading each
// property once, and refuses a value that is not the primitive its field expects. These tables attack that boundary
// once, with the shapes a careful developer passes and the hostile ones.

const ISO = '2026-11-01T00:00:00.000Z';
const ISO_TO = '2026-11-02T00:00:00.000Z';
const at = (iso: string) => new Date(iso);

/** Every value in the snapshot, nested ones included, is a string or a number, and every object is frozen. */
function expectPlainPrimitives(value: object) {
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  for (const field of Object.values(value)) {
    if (typeof field === 'object' && field !== null) expectPlainPrimitives(field);
    else expect(['string', 'number']).toContain(typeof field);
  }
}

class Session {
  constructor(private readonly id: string) {}
  get tenant() {
    return this.id;
  }
}
class Range {
  get from() {
    return at(ISO);
  }
  get to() {
    return ISO_TO;
  }
}
class LyingDate extends Date {
  override toISOString() {
    return '1970-01-01T00:00:00.000Z';
  }
  override toJSON() {
    return '1970-01-01T00:00:00.000Z';
  }
  override getTime() {
    return 0;
  }
}
const hidden = <T extends object>(object: T, key: string, value: unknown) => Object.defineProperty(object, key, { value, enumerable: false });

describe('the trail boundary accepts the shapes a careful developer passes', () => {
  const cases: [string, () => unknown, string, Record<string, unknown>?][] = [
    ['a plain object', () => ({ tenant: 'acme' }), 'tenant:"acme"'],
    ['a class instance with a prototype getter', () => Object.assign(new Session('acme'), {}), 'tenant:"acme"'],
    ['an inherited selector', () => Object.create({ tenant: 'acme' }), 'tenant:"acme"'],
    ['a non-enumerable selector', () => hidden({}, 'tenant', 'acme'), 'tenant:"acme"'],
    ['a non-enumerable q', () => hidden({ tenant: 'acme' }, 'q', 'action:a'), '(action:a) AND tenant:"acme"'],
    ['a Proxy that serves the selector', () => new Proxy({}, { get: (_, key) => (key === 'tenant' ? 'acme' : undefined) }), 'tenant:"acme"'],
    [
      'a target class with getters',
      () => ({
        target: new (class {
          get id() {
            return 'inv_1';
          }
          get type() {
            return 'invoice';
          }
        })(),
      }),
      'record:"invoice:inv_1"',
    ],
    ['Date range bounds', () => ({ tenant: 'acme', range: { from: at(ISO), to: at(ISO_TO) } }), 'tenant:"acme"', { from: ISO, to: ISO_TO }],
    [
      'epoch-millisecond range bounds',
      () => ({ tenant: 'acme', range: { from: at(ISO).getTime(), to: at(ISO_TO).getTime() } }),
      'tenant:"acme"',
      { from: ISO, to: ISO_TO },
    ],
    ['a range class with getters', () => ({ tenant: 'acme', range: new Range() }), 'tenant:"acme"', { from: ISO, to: ISO_TO }],
    // The Date's own methods are never called: its internal time value is read.
    ['a Date subclass whose methods lie', () => ({ tenant: 'acme', range: { from: new LyingDate(ISO) } }), 'tenant:"acme"', { from: ISO }],
    [
      'a range whose toJSON lies',
      () => ({ tenant: 'acme', range: { from: ISO, toJSON: () => ({ from: '1970-01-01T00:00:00.000Z' }) } }),
      'tenant:"acme"',
      { from: ISO },
    ],
    ['a limit as URL digits', () => ({ tenant: 'acme', limit: '20' }), 'tenant:"acme"', { limit: 20 }],
    // Round 5: a class with its own toStringTag is still an ordinary class instance.
    [
      'a class instance with a custom toStringTag',
      () =>
        new (class {
          readonly [Symbol.toStringTag] = 'Session';
          tenant = 'acme';
        })(),
      'tenant:"acme"',
    ],
    // Round 6: only built-in prototypes are refused; a class tagged like a built-in is still an ordinary instance.
    [
      'a class tagged Map',
      () => ({
        tenant: 'acme',
        range: new (class {
          readonly [Symbol.toStringTag] = 'Map';
          from = ISO;
        })(),
      }),
      'tenant:"acme"',
      { from: ISO },
    ],
    [
      'a class instance under a plain prototype that owns constructor: Object',
      () => {
        const base = { constructor: Object, tenant: 'acme' };
        class Scope {}
        Object.setPrototypeOf(Scope.prototype, base);
        return new Scope();
      },
      'tenant:"acme"',
    ],
    [
      'a record with an accessor named get (never evaluated) and an undefined iterator slot',
      () => ({
        tenant: 'acme',
        get get(): never {
          throw new Error('the boundary must not run this accessor');
        },
        [Symbol.iterator]: undefined,
      }),
      'tenant:"acme"',
    ],
    ['a null-prototype object', () => Object.assign(Object.create(null), { tenant: 'acme' }), 'tenant:"acme"'],
    [
      'a millisecond ISO string bound',
      () => ({ tenant: 'acme', range: { from: '2026-11-01T00:00:00.123Z' } }),
      'tenant:"acme"',
      { from: '2026-11-01T00:00:00.123Z' },
    ],
  ];
  it.each(cases)('%s', (_, make, q, extra = {}) => {
    const input = make() as TrailQuery;
    const snapshot = snapshotTrail(input);
    expectPlainPrimitives(snapshot);
    expect(trailQuery(input)).toEqual({ q, limit: undefined, cursor: undefined, ...extra });
    // The snapshot is itself a valid input, and builds the same query.
    expect(trailQuery(snapshot)).toEqual(trailQuery(input));
  });

  it('reads every property exactly once, so a getter cannot pass the check and then change', () => {
    const reads: Record<string, number> = {};
    const counted = new Proxy(
      { target: { id: 'inv_1' }, tenant: 'acme', q: 'action:a', range: { from: ISO }, limit: 5, cursor: 'c1', actor: 'u1' },
      {
        get(object, key, receiver) {
          const count = (reads[String(key)] ?? 0) + 1;
          reads[String(key)] = count;
          // Every read after the first returns a widening value.
          if (count > 1) return key === 'tenant' || key === 'actor' ? '' : undefined;
          return Reflect.get(object, key, receiver);
        },
      },
    );
    expect(trailQuery(counted).q).toBe('(action:a) AND target:"inv_1" AND actor:"u1" AND tenant:"acme"');
    for (const key of ['target', 'tenant', 'q', 'range', 'limit', 'cursor', 'actor']) expect(reads[key], key).toBe(1);
  });
});

describe('the trail boundary refuses a value that is not the primitive its field expects', () => {
  const cases: [string, unknown][] = [
    // biome-ignore lint/style/useConsistentBuiltinInstantiation: the wrapper object is the hostile shape under test
    ['a String object as a selector', { tenant: new String('acme') }],
    ['a number as a selector', { actor: 42 }],
    ['an object with toString as a selector', { tenant: { toString: () => 'acme' } }],
    ['an array as q', { tenant: 'acme', q: ['action:a'] }],
    ['an object as a range bound', { tenant: 'acme', range: { from: { toString: () => ISO } } }],
    ['an object with toJSON as a range bound', { tenant: 'acme', range: { from: { toJSON: () => ISO } } }],
    ['an invalid Date', { tenant: 'acme', range: { from: new Date('nope') } }],
    ['NaN as a range bound', { tenant: 'acme', range: { to: Number.NaN } }],
    ['Infinity as a range bound', { tenant: 'acme', range: { to: Number.POSITIVE_INFINITY } }],
    ['a boolean as a range bound', { tenant: 'acme', range: { from: true } }],
    ['a string as the range', { tenant: 'acme', range: ISO }],
    ['null as the range', { tenant: 'acme', range: null }],
    ['a fractional limit', { tenant: 'acme', limit: 1.5 }],
    ['an object limit with valueOf', { tenant: 'acme', limit: { valueOf: () => 20 } }],
    ['a non-digit limit string', { tenant: 'acme', limit: '20; DROP' }],
    ['a number as the cursor', { tenant: 'acme', cursor: 7 }],
    ['a lone surrogate in the cursor', { tenant: 'acme', cursor: '\uDC00' }],
    ['a lone surrogate in a range bound', { tenant: 'acme', range: { from: `${ISO}\uD800` } }],
    ['a non-string target type', { target: { type: 1, id: 'x' } }],
    // Round 4: containers without the named fields would silently drop every bound or selector.
    ['a date picker array as the range', { tenant: 'acme', range: [new Date(ISO), new Date(ISO_TO)] }],
    ['a Date as the range', { tenant: 'acme', range: new Date(ISO) }],
    ['a Map as the range', { tenant: 'acme', range: new Map([['from', ISO]]) }],
    ['a range with neither bound', { tenant: 'acme', range: {} }],
    ['a range with other names', { tenant: 'acme', range: { start: ISO, end: ISO_TO } }],
    ['an array as the target', { target: [{ id: 'x' }] }],
    ['an array as the options', [{ tenant: 'acme' }]],
    ['fractional epoch milliseconds', { tenant: 'acme', range: { from: Date.parse(ISO) + 0.5 } }],
    ['a sub-millisecond ISO string bound', { tenant: 'acme', range: { from: '2026-11-01T00:00:00.0005Z' } }],
    // Round 6: built-in prototypes are refused whatever their tag says.
    [
      'a class extending Map',
      {
        tenant: 'acme',
        range: (() => {
          class Bounds extends Map<string, string> {}
          return new Bounds([['from', ISO]]);
        })(),
      },
    ],
    ['URLSearchParams as the options', new URLSearchParams('tenant=acme')],
    ['a target that is a string', { target: 'inv_1' }],
    ['no options object', 'tenant:acme'],
  ];
  it.each(cases)('%s', (_, input) => {
    const thrown = (() => {
      try {
        trailQuery(input as TrailQuery);
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(TrailQueryError);
    expect(thrown).toBeInstanceOf(TypeError);
    expect(isTrailQueryError(thrown)).toBe(true);
  });

  it('refuses untrusted strings that would leave the selectors, whatever their content', () => {
    for (const q of ['a) OR (tenant:other', ') OR (', 'x) OR tenant:* OR (y', '"unterminated'])
      expect(() => trailQuery({ tenant: 'acme', q }), q).toThrow(TrailQueryError);
    // A hostile selector value is quoted, never parsed.
    expect(trailQuery({ tenant: 'acme") OR (tenant:"other' }).q).toBe('tenant:"acme\\") OR (tenant:\\"other"');
  });

  it('tells only its own errors apart', () => {
    expect(isTrailQueryError(new TypeError('x'))).toBe(false);
    expect(isTrailQueryError(Object.assign(new TypeError('x'), { code: 'trail_query_invalid' }))).toBe(true);
    expect(isTrailQueryError({ code: 'trail_query_invalid' })).toBe(false);
  });
});

describe('the search query boundary (readAuditTrail, the Vue engine, the Nuxt route)', () => {
  const sent = async (query: unknown) => {
    const urls: URL[] = [];
    await readAuditTrail(
      {
        endpoint: 'http://logbird.test/',
        readKey: 'lb_read_fake',
        fetch: (async (url: URL) => {
          urls.push(new URL(url));
          return Response.json({ data: [], nextCursor: null, total: 0, tookMs: 0 });
        }) as typeof fetch,
      },
      query as SearchInput,
    );
    return Object.fromEntries((urls[0] as URL).searchParams);
  };

  it.each<[string, () => unknown, Record<string, string>]>([
    ['a plain object', () => ({ q: 'tenant:"acme"', limit: 10 }), { q: 'tenant:"acme"', limit: '10' }],
    // Object.entries would have dropped these two and read the whole project.
    [
      'a class instance with a getter q',
      () =>
        new (class {
          get q() {
            return 'tenant:"acme"';
          }
        })(),
      { q: 'tenant:"acme"' },
    ],
    ['a non-enumerable q', () => hidden({}, 'q', 'tenant:"acme"'), { q: 'tenant:"acme"' }],
    ['Date bounds', () => ({ q: 'tenant:"acme"', from: at(ISO), to: new LyingDate(ISO_TO) }), { q: 'tenant:"acme"', from: ISO, to: ISO_TO }],
    ['unknown keys, which are dropped', () => ({ q: 'tenant:"acme"', tenant: 'other', scope: 'all' }), { q: 'tenant:"acme"' }],
    [
      'a class instance with a custom toStringTag',
      () =>
        new (class {
          readonly [Symbol.toStringTag] = 'Query';
          q = 'tenant:"acme"';
        })(),
      { q: 'tenant:"acme"' },
    ],
    [
      'every known field',
      () => ({ q: 'a', lang: 'query', from: ISO, to: ISO_TO, limit: '5', cursor: 'c', order: 'asc' }),
      { q: 'a', lang: 'query', from: ISO, to: ISO_TO, limit: '5', cursor: 'c', order: 'asc' },
    ],
  ])('sends exactly the snapshot of %s', async (_, make, expected) => {
    const snapshot = snapshotSearchQuery(make() as SearchInput);
    expectPlainPrimitives(snapshot);
    expect(await sent(make())).toEqual(expected);
  });

  it.each<[string, unknown]>([
    ['an array q', { q: ['a', 'b'] }],
    ['an object q with toString', { q: { toString: () => 'tenant:"acme"' } }],
    ['a lone surrogate in q', { q: 'tenant:"a\uD800"' }],
    ['an unknown order', { q: 'a', order: 'random' }],
    ['an unknown lang', { q: 'a', lang: 'graphql' }],
    ['an object bound', { q: 'a', from: { toJSON: () => ISO } }],
    ['no query object', 'q=a'],
    ['an array of queries', [{ q: 'tenant:"acme"' }]],
    ['a Map as the query', new Map([['q', 'tenant:"acme"']])],
    ['a Date as the query', new Date(ISO)],
    ['fractional epoch milliseconds', { q: 'a', from: Date.parse(ISO) + 0.5 }],
    ['a sub-millisecond ISO string bound', { q: 'a', from: '2026-11-01T00:00:00.0005+00:00' }],
    ['a Set as the query', new Set(['q'])],
    // Round 6: URL parameter containers have no `q` property, so reading them would drop the filter.
    ['URLSearchParams as the query', new URLSearchParams('q=tenant:"acme"')],
    ['Headers as the query', new Headers({ q: 'tenant:"acme"' })],
    // Round 7: judged by behaviour, so containers from another copy or library are refused too.
    [
      'a Map-like store (MobX ObservableMap shape) holding q',
      new (class {
        readonly [Symbol.toStringTag] = 'Map';
        readonly data = new globalThis.Map([['q', 'tenant:"acme"']]);
        get(key: string) {
          return this.data.get(key);
        }
      })(),
    ],
    [
      'a Headers class from another fetch copy',
      new (class {
        get(name: string) {
          return name === 'q' ? 'tenant:"acme"' : null;
        }
        *[Symbol.iterator]() {
          yield ['q', 'tenant:"acme"'];
        }
      })(),
    ],
    ['a Date-like object', { getTime: () => 0, toISOString: () => '' }],
    [
      'an entry collection serving its iterator through an accessor',
      Object.defineProperty({}, Symbol.iterator, { get: () => () => [['q', 'tenant:"acme"']][Symbol.iterator]() }),
    ],
    // Round 8: async entry sources and never-awaited promises (from any realm) hold no named fields either.
    ['a ReadableStream of entries', new ReadableStream({ start: (controller) => controller.enqueue(['q', 'tenant:"acme"']) })],
    [
      'an async-iterable entry source',
      new (class {
        async *[Symbol.asyncIterator]() {
          yield ['q', 'tenant:"acme"'];
        }
      })(),
    ],
    ['an unawaited promise from another realm', runInNewContext('Promise.resolve({ q: "tenant:\\"acme\\"" })')],
    // biome-ignore lint/suspicious/noThenProperty: the thenable is the hostile shape under test
    ['a thenable', { then: (resolve: (value: unknown) => void) => resolve({ q: 'tenant:"acme"' }) }],
    [
      'FormData as the query',
      (() => {
        const form = new FormData();
        form.set('q', 'tenant:"acme"');
        return form;
      })(),
    ],
  ])('refuses %s before any request', async (_, query) => {
    await expect(sent(query)).rejects.toBeInstanceOf(TrailQueryError);
  });

  // The owner's ruling: the guarantee does not rest on the container list. An object the container rule does not know
  // (hand-made, keeping `q` behind its own method) passes as a record with no named `q`, and the last check, on the
  // outgoing query, refuses the request before it leaves.
  it('never sends a request without q, whatever the input object was', async () => {
    const unknownContainer = new (class {
      readonly entries = { q: 'tenant:"acme"' };
      field(name: 'q') {
        return this.entries[name];
      }
    })();
    let calls = 0;
    const options = {
      endpoint: 'http://logbird.test',
      readKey: 'lb_read_fake',
      fetch: (async () => {
        calls++;
        return Response.json({ data: [], nextCursor: null, total: 0, tookMs: 0 });
      }) as typeof fetch,
    };
    for (const query of [unknownContainer, {}, { q: '' }, { q: '   ' }, { limit: 50, order: 'asc' }]) {
      await expect(readAuditTrail(options, query as SearchInput)).rejects.toThrow(/the query has no `q`, so it would read the whole project/);
    }
    expect(calls).toBe(0);
    // A whole-project read is still possible when asked for explicitly.
    await readAuditTrail(options, { q: 'timestamp:*' });
    expect(calls).toBe(1);
  });

  it('reads each field once', () => {
    const reads: Record<string, number> = {};
    const query = new Proxy(
      { q: 'tenant:"acme"', limit: 10, order: 'desc' },
      {
        get(object, key, receiver) {
          const count = (reads[String(key)] ?? 0) + 1;
          reads[String(key)] = count;
          return count > 1 ? undefined : Reflect.get(object, key, receiver);
        },
      },
    );
    expect(snapshotSearchQuery(query as SearchInput)).toEqual({ q: 'tenant:"acme"', limit: 10, order: 'desc' });
    for (const key of ['q', 'lang', 'from', 'to', 'limit', 'cursor', 'order']) expect(reads[key], key).toBe(1);
  });

  it('keys pagination by the canonical snapshot, so different trails never share a key', () => {
    const key = (query: SearchInput) => searchKey(snapshotSearchQuery(query));
    // The same events asked in different shapes share a key; the cursor is not part of it.
    expect(key({ q: 'tenant:"a"', from: at(ISO) })).toBe(key({ from: ISO, q: 'tenant:"a"', cursor: 'c' }));
    // Values that a looser serialisation could confuse stay apart.
    const keys = [
      { q: 'tenant:"a"' },
      { q: 'tenant:"b"' },
      { q: 'tenant:"a"', limit: 10 },
      { q: 'tenant:"a"', from: ISO },
      { q: 'tenant:"a"', to: ISO },
      { q: 'tenant:"a"', order: 'asc' as const },
      { q: '["tenant:\\"a\\"",null]' },
      { q: 'null' },
      {},
    ].map(key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
