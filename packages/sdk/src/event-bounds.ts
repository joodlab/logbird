import { LogbirdError } from './errors';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_DEPTH = 1000;
const MAX_EVENT_DEPTH = MAX_DEPTH + 8;
const isRawJson = (JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean }).isRawJSON;

interface Position {
  remaining: number;
  branch?: 'root' | 'changes' | 'change';
}

const topLevel: Position = { remaining: MAX_EVENT_DEPTH, branch: 'root' };

function memberPosition(parent: Position, key: string): Position {
  const { branch, remaining } = parent;
  if ((branch === 'root' && key === 'metadata') || (branch === 'change' && (key === 'before' || key === 'after'))) {
    return { remaining: MAX_DEPTH };
  }
  if (branch === 'root' && key === 'changes') return { remaining: remaining - 1, branch: 'changes' };
  if (branch === 'changes') return { remaining: remaining - 1, branch: 'change' };
  return { remaining: remaining - 1 };
}

function checkDepth(value: unknown, position: Position) {
  if (value !== null && !omitted(value) && position.remaining < 1) throw new LogbirdError('input_too_deep');
}

function omitted(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

function boxedText(value: object): string | undefined {
  // Boxed strings always have their own length, even if the host changes the prototype.
  if (!Object.hasOwn(value, 'length')) return;
  try {
    return String.prototype.valueOf.call(value);
  } catch {
    return undefined;
  }
}

function scalarObjectBytes(value: object): number | undefined {
  if (isRawJson?.(value)) return (value as { rawJSON: string }).rawJSON.length;
  const text = boxedText(value);
  if (text !== undefined) return text.length + 2;
}

export function inputBoundReason(error: unknown): 'input_too_large' | 'input_too_deep' | undefined {
  try {
    if (!error || typeof error !== 'object') return;
    const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (code === 'input_too_large' || code === 'input_too_deep') return code;
  } catch {
    return undefined;
  }
}

function lowerBound(value: unknown): number {
  if (typeof value === 'string') return value.length + 2;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === 'boolean') return value ? 4 : 5;
  return value === null ? 4 : 2;
}

function* members(value: object, root: boolean): Generator<[string, unknown]> {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && !('value' in descriptor)) throw new LogbirdError('event_invalid');
      yield [key, descriptor?.value ?? null];
    }
    return;
  }
  // biome-ignore lint/suspicious/useGuardForIn: The descriptor lookup checks ownership without querying a proxy twice.
  for (const key in value) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) continue;
    if (!('value' in descriptor)) {
      if (root && key === 'id') continue;
      throw new LogbirdError('event_invalid');
    }
    yield [key, descriptor.value];
  }
}

interface Frame {
  value: object;
  members: Iterator<[string, unknown]>;
  first: boolean;
  position: Position;
}

/** Measures original data before copying it or calling host hooks. Keep one frame per open container. */
export function checkEventBounds(root: unknown, envelopeBytes = 0) {
  let bytes = envelopeBytes;
  if (bytes > MAX_INPUT_BYTES) throw new LogbirdError('input_too_large');
  let visited = 0;
  const frames: Frame[] = [];
  const active = new WeakSet<object>();
  const visit = (value: unknown, position: Position) => {
    checkDepth(value, position);
    const scalarBytes = value && typeof value === 'object' && !Array.isArray(value) ? scalarObjectBytes(value) : undefined;
    bytes += scalarBytes ?? lowerBound(value);
    if (value && typeof value === 'object' && scalarBytes === undefined) {
      if (active.has(value)) throw new LogbirdError('event_invalid');
      if (Array.isArray(value) && value.length) bytes += value.length - 1;
      active.add(value);
      frames.push({ value, members: members(value, frames.length === 0), first: true, position });
    }
    if (bytes > MAX_INPUT_BYTES) throw new LogbirdError('input_too_large');
  };
  visit(root, topLevel);
  while (frames.length) {
    const frame = frames.at(-1);
    if (!frame) break;
    const next = frame.members.next();
    if (next.done) {
      frames.pop();
      active.delete(frame.value);
      continue;
    }
    // Bound the work even when the properties would be omitted by JSON.stringify.
    if (++visited > MAX_INPUT_BYTES) throw new LogbirdError('input_too_large');
    const [key, value] = next.value;
    if (!Array.isArray(frame.value)) {
      if (omitted(value)) continue;
      bytes += key.length + 3 + Number(!frame.first);
      frame.first = false;
    }
    visit(value, memberPosition(frame.position, key));
  }
}

type Replacer = (this: object, key: string, value: unknown) => unknown;

/** Check values exposed by toJSON before the serializer expands their strings or descends into them. */
export function stringifyEvent(event: unknown, replace?: Replacer): string {
  let remaining = MAX_INPUT_BYTES;
  let visited = 0;
  const positions = new WeakMap<object, Position>();
  return JSON.stringify(event, function guarded(this: object, key, value: unknown) {
    if (++visited > MAX_INPUT_BYTES) throw new LogbirdError('input_too_large');
    const parent = positions.get(this);
    const position = parent ? memberPosition(parent, key) : topLevel;
    checkDepth(value, position);
    const initialBytes = value && typeof value === 'object' && !Array.isArray(value) ? scalarObjectBytes(value) : undefined;
    if ((initialBytes ?? lowerBound(value)) > MAX_INPUT_BYTES || (Array.isArray(value) && value.length > MAX_INPUT_BYTES)) {
      throw new LogbirdError('input_too_large');
    }
    let transformed = replace ? replace.call(this, key, value) : value;
    if (transformed && typeof transformed === 'object') {
      if (Array.isArray(transformed) && transformed.length > MAX_INPUT_BYTES) throw new LogbirdError('input_too_large');
      // Measure the actual string conversion, including custom primitive conversion on a boxed string.
      if (!Array.isArray(transformed) && boxedText(transformed) !== undefined) transformed = String(transformed);
      else positions.set(transformed, position);
    }
    const arrayMember = Array.isArray(this);
    if (!arrayMember && omitted(transformed)) return transformed;
    const finalBytes = transformed && typeof transformed === 'object' && !Array.isArray(transformed) ? scalarObjectBytes(transformed) : undefined;
    // Array indices are not written as property names, and omitted array values become null.
    remaining -= (arrayMember ? 1 : key.length + 4) + (finalBytes ?? (omitted(transformed) ? 4 : lowerBound(transformed)));
    if (remaining < 0) throw new LogbirdError('input_too_large');
    return transformed;
  });
}
