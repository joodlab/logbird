import { LogbirdError, safeDiagnostic } from './errors';
import { stringifyEvent } from './event-bounds';
import type { EventInput } from './index';

export const DEFAULT_SECRET_KEYS = /passw(or)?d|secret|token|otp|api[-_]?key|authorization|cookie|credential|private[-_]?key/i;
/**
 * The parties' identifier and classification fields: never redacted, whatever the pattern. A redacted id would merge
 * every identity into one, and an executor's attempt must stay a number. To pseudonymise an id, transform it before
 * recording. The .NET SDK's `Redactor.IdentifierFields` lists the same fields.
 */
export const IDENTIFIER_FIELDS: readonly string[] = Object.freeze([
  'actor.type',
  'actor.id',
  'impersonator.id',
  'executor.type',
  'executor.id',
  'executor.jobId',
  'executor.attempt',
  'tenant.id',
  'targets[].type',
  'targets[].id',
]);

type Level = 'nested' | 'top' | 'actor' | 'impersonator' | 'executor' | 'tenant' | 'targets' | 'target' | 'changes' | 'change';

const IDENTITY: Record<Level, readonly string[]> = {
  nested: [],
  top: ['id', 'action'],
  actor: ['id', 'type'],
  impersonator: ['id'],
  executor: ['id', 'type', 'jobId', 'attempt'],
  tenant: ['id'],
  targets: [],
  target: ['id', 'type'],
  changes: [],
  change: [],
};

const PARTIES: Record<string, Level> = { actor: 'actor', impersonator: 'impersonator', executor: 'executor', tenant: 'tenant', targets: 'targets' };

export interface RedactionOptions {
  /** Matches keys at any depth. Defaults to DEFAULT_SECRET_KEYS. */
  keys?: RegExp;
  /** Extra literal substrings, matched with ASCII case folding. */
  addKeys?: string[];
  /** Matches change field names. Defaults to keys and addKeys. */
  changeFields?: RegExp;
  /** Exact event paths to redact. A whole segment of '*' matches one key or index. */
  paths?: string[];
  /** Exact event paths exempt from their own key match. */
  keepPaths?: string[];
  /** Defaults to '[redacted]'. */
  replacement?: string;
}

const WILDCARD = Symbol('wildcard');
type Segment = string | typeof WILDCARD;
type PathNode = { children: Map<Segment, PathNode>; redact?: true; keep?: true };
const NO_PATHS: readonly PathNode[] = [];
const TARGET_INDEX = /^(0|[1-9][0-9]*)$/;
const IDENTIFIER_PATHS = [...IDENTITY.top, ...IDENTIFIER_FIELDS].map((field) => ({ field, parts: field.replace('[]', '.*').split('.') }));
const PATH_SEGMENT = /^(?:\*|(?:[^.*\\]|\\[.*\\])+)$/;
const PATH_PART = /(?:\\.|[^.\\])+/gs;
const PATH_ESCAPE = /\\([.*\\])/g;
const ASCII_UPPER = /[A-Z]/g;
const asciiLower = (value: string) => value.replace(ASCII_UPPER, (letter) => letter.toLowerCase());
const isRawJSON = (JSON as { isRawJSON?: (value: unknown) => value is { readonly rawJSON: string } }).isRawJSON;

function parsePath(value: string, option: 'paths' | 'keepPaths', index: number): Segment[] {
  const parts = typeof value === 'string' ? value.match(PATH_PART) : null;
  if (!parts || parts.join('.') !== value || parts.some((part) => !PATH_SEGMENT.test(part))) {
    throw new TypeError(`Invalid redaction ${option} entry at index ${index}`);
  }
  return parts.map((part) => (part === '*' ? WILDCARD : part.replace(PATH_ESCAPE, '$1')));
}

function compilePaths(options: RedactionOptions) {
  const root: PathNode = { children: new Map() };
  const matchesIdentifier = new Set<string>();
  for (const option of ['paths', 'keepPaths'] as const) {
    for (const [index, value] of (options[option] ?? []).entries()) {
      const segments = parsePath(value, option, index);
      if (option === 'paths') {
        for (const { field, parts } of IDENTIFIER_PATHS) {
          if (
            parts.length === segments.length &&
            segments.every((segment, j) => {
              const part = parts[j];
              return segment === WILDCARD || (part === '*' ? TARGET_INDEX.test(segment) : part === segment);
            })
          ) {
            matchesIdentifier.add(field);
          }
        }
      }
      let node = root;
      for (const segment of segments) {
        let child = node.children.get(segment);
        if (!child) {
          child = { children: new Map() };
          node.children.set(segment, child);
        }
        node = child;
      }
      if (option === 'paths') node.redact = true;
      else node.keep = true;
    }
  }
  return { root, matchesIdentifier };
}

function childPaths(nodes: readonly PathNode[], key: string): readonly PathNode[] {
  if (nodes.length === 0) return NO_PATHS;
  const children: PathNode[] = [];
  for (const node of nodes) {
    const exact = node.children.get(key);
    const wildcard = node.children.get(WILDCARD);
    if (exact) children.push(exact);
    if (wildcard) children.push(wildcard);
  }
  return children.length === 0 ? NO_PATHS : children;
}

/**
 * Redact a deep copy. Logbird clients apply redaction automatically; use this helper
 * when you need to redact an event yourself.
 *
 * A key matches when the pattern matches any part of it (the default redacts `tokenCount` and `secretary` too); anchor
 * your own pattern (`/^name$/`) to match whole keys. A matching key keeps its name and its value becomes the replacement,
 * at any depth. Identity is never redacted: the top-level `id` and `action`, and {@link IDENTIFIER_FIELDS}. A pattern
 * that matches a party's own key (`actor`, `impersonator`, `executor`, `tenant` or `targets`), or a target's index, redacts
 * every other field of that party and keeps its identifier fields; a party object is never replaced as a whole (one that
 * is not an object is replaced like any other value). A change's
 * values are replaced when its `field` is a string the change pattern matches.
 *
 * The .NET SDK's `Redactor` follows the same rules, checked against one shared fixture: with the default pattern (and
 * names added like the .NET `AddKeys`), both redact exactly the same keys. A pattern of your own runs on each platform's
 * regular-expression engine, which can differ at the edges (in .NET, `$` also matches before a final line feed; flags
 * such as `i` fold case differently), so keep custom patterns to plain alternatives and anchors that mean the same in
 * both. It returns the event as JSON will send it: redaction runs inside `JSON.stringify` itself (as its replacer), so
 * every value is read, and every `toJSON` applied, exactly as sending the event reads them, and a matched value is
 * replaced before it is serialized (a value JSON cannot hold, such as a `BigInt` under a secret key, never stops the
 * event). An object reached twice becomes two copies. A cycle throws a `LogbirdError` with code `redaction_failed`.
 *
 * The contract: `redact()` is exact for JSON data, which is what `EventInput` types: plain objects, arrays, primitives,
 * and `toJSON` values (such as `Date`) without side effects on other parts of the event. Getters or `toJSON` with side
 * effects on other parts of the event, or anything that changes the event while it is serialized, are outside it. A
 * change whose `field` is a getter, an inherited or non-enumerable property, a boxed string, a bigint, or an object
 * with a `toJSON` has its `before` and `after` redacted, whatever the pattern. Other non-string fields are not matched.
 */
export function redact(options?: RedactionOptions): (event: EventInput) => EventInput {
  const serialize = createRedactor(options);
  return (event) => JSON.parse(serialize(event)) as EventInput;
}

export function createRedactor(options: RedactionOptions = {}, report?: (error: LogbirdError) => void): (event: EventInput) => string {
  try {
    return compileRedactor(options, report);
  } catch {
    throw new LogbirdError('redaction_options_invalid');
  }
}

function compileRedactor(options: RedactionOptions, report?: (error: LogbirdError) => void): (event: EventInput) => string {
  const keys = new RegExp(options.keys ?? DEFAULT_SECRET_KEYS);
  const fields = options.changeFields && new RegExp(options.changeFields);
  const names = options.addKeys?.map(asciiLower) ?? [];
  const replacement = options.replacement ?? '[redacted]';
  const { root, matchesIdentifier } = compilePaths(options);
  const rootPaths = root.children.size ? [root] : NO_PATHS;
  const matches = (pattern: RegExp, key: string) => {
    pattern.lastIndex = 0;
    return pattern.test(key);
  };
  const matchesKey = (key: string) => {
    if (matches(keys, key)) return true;
    if (names.length === 0) return false;
    const folded = asciiLower(key);
    return names.some((name) => folded.includes(name));
  };
  if (report) {
    for (const key of ['id', 'action', 'type', 'jobId', 'attempt']) {
      if (matchesKey(key)) matchesIdentifier.add(key);
    }
    if (matchesIdentifier.size) report(new LogbirdError('redaction_identifier_rule', { count: matchesIdentifier.size }));
  }
  return (event) => {
    // Redaction runs as JSON.stringify's replacer, so the event is read exactly as sending it reads it (each getter once,
    // in order; toJSON applied first; boxed primitives unwrapped; a cycle throws a TypeError). The replacer sees each
    // value after toJSON and before it is serialized: a matched value is replaced without being serialized. Each object
    // it lets through is recorded with the rules for its own children; serialization is depth-first, so an object reached
    // twice is finished in its first place before its second. The result is the event as JSON will send it, which is also
    // the tree the .NET SDK redacts.
    type Context = { level: Level; whole: boolean; changed: boolean; paths: readonly PathNode[] };
    const contexts = new WeakMap<object, Context>();
    const omitted = (value: unknown) => value === undefined || typeof value === 'function' || typeof value === 'symbol';
    // A boxed primitive as JSON.stringify tells one, by its internal slot (any realm), not by its prototype: only a real
    // Number, String, Boolean or BigInt object is serialized as its primitive.
    const brands: Array<(this: unknown) => unknown> = [
      Number.prototype.valueOf,
      String.prototype.valueOf,
      Boolean.prototype.valueOf,
      BigInt.prototype.valueOf,
    ];
    const hasBrand = (value: object, unbox: (this: unknown) => unknown) => {
      try {
        unbox.call(value);
        return true;
      } catch {
        return false;
      }
    };
    const isObject = (value: unknown): value is Record<string, unknown> =>
      !!value && typeof value === 'object' && !Array.isArray(value) && !isRawJSON?.(value) && !brands.some((unbox) => hasBrand(value, unbox));
    const keep = (value: unknown, context: Context) => {
      if (value && typeof value === 'object') contexts.set(value, context);
      return value;
    };
    const nested: Context = { level: 'nested', whole: false, changed: false, paths: NO_PATHS };
    // A change's values are decided from its field's property descriptor, before anything is serialized and without
    // reading the field. An own, enumerable string data property is matched against the change pattern. A field whose
    // field can serialize to a string through toJSON or boxed-string coercion, or come from a getter, inherited or
    // non-enumerable property. In those cases redact the values without trying to evaluate the field again.
    const changeEntry = (entry: Record<string, unknown>, paths: readonly PathNode[]) => {
      const own = Object.getOwnPropertyDescriptor(entry, 'field');
      let changed: boolean;
      if (own === undefined) changed = 'field' in entry;
      else if (!('value' in own) || !own.enumerable) changed = true;
      else {
        // JSON.rawJSON can supply a primitive string without using a JS string or toJSON.
        const field: unknown = isRawJSON?.(own.value) ? JSON.parse(own.value.rawJSON) : own.value;
        if (typeof field === 'string') changed = fields ? matches(fields, field) : matchesKey(field);
        // JSON.stringify can invoke BigInt.prototype.toJSON even for primitive fields, including 0n.
        else if (typeof field === 'bigint') changed = true;
        else
          changed =
            !!field &&
            (typeof field === 'object' || typeof field === 'function') &&
            (typeof (field as { toJSON?: unknown }).toJSON === 'function' || hasBrand(field, String.prototype.valueOf));
      }
      return keep(entry, { level: 'change', whole: false, changed, paths });
    };
    function replacer(this: unknown, key: string, value: unknown): unknown {
      const holder = this && typeof this === 'object' ? contexts.get(this) : undefined;
      if (!holder) return keep(value, { level: 'top', whole: false, changed: false, paths: rootPaths });
      const { level, whole, changed } = holder;
      if (!Array.isArray(this) && IDENTITY[level].includes(key)) {
        // Identifiers are scalar. Refuse malformed containers so the identity exemption cannot hide a secret subtree.
        if (Array.isArray(value) || isObject(value)) throw new LogbirdError('redaction_identifier_invalid');
        return value;
      }
      const paths = childPaths(holder.paths, key);
      const matched =
        whole ||
        (changed && (key === 'before' || key === 'after')) ||
        paths.some((path) => path.redact) ||
        (!paths.some((path) => path.keep) && matchesKey(key));
      const child = paths.length ? { ...nested, paths } : nested;
      if (Array.isArray(this)) {
        if (level === 'targets') {
          // Target entries are parties: never replaced as a whole, and their type and id are kept. A pattern matching
          // an entry's index (or the targets key) redacts the entry's other fields; a scalar entry is replaced.
          if (isObject(value)) return keep(value, { level: 'target', whole: matched, changed: false, paths });
          return matched ? replacement : keep(value, child);
        }
        // Array entries are matched by their index ("0", "1", ...), as Object.entries gives them.
        if (matched) return replacement;
        // Change values are decided on the field as recorded; only an object entry with a string field is matched.
        if (level === 'changes' && isObject(value)) return changeEntry(value, paths);
        return keep(value, child);
      }
      const party = level === 'top' && Object.hasOwn(PARTIES, key) ? (PARTIES[key] ?? 'nested') : 'nested';
      if (party !== 'nested' && (party === 'targets' ? Array.isArray(value) : isObject(value))) {
        // A party is never replaced as a whole; a match redacts everything but its identity.
        return keep(value, { level: party, whole: matched, changed: false, paths });
      }
      if (matched) return omitted(value) ? undefined : replacement;
      return keep(value, level === 'top' && key === 'changes' && Array.isArray(value) ? { ...child, level: 'changes' } : child);
    }
    try {
      const serialized = stringifyEvent(event, replacer);
      if (!serialized?.startsWith('{')) throw new LogbirdError('redaction_failed');
      return serialized;
    } catch (error) {
      const diagnostic = safeDiagnostic(error, 'redaction_failed');
      if (
        diagnostic.code === 'input_too_large' ||
        diagnostic.code === 'input_too_deep' ||
        diagnostic.code === 'event_too_large' ||
        diagnostic.code === 'redaction_identifier_invalid'
      )
        throw diagnostic;
      throw new LogbirdError('redaction_failed');
    }
  };
}
