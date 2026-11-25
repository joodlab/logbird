import { LogbirdError } from './errors';

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_DEPTH = 1000;

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
}

/** Measures original data before copying it or calling host hooks. Keep one frame per open container. */
export function checkEventBounds(root: unknown) {
  let bytes = 0;
  let visited = 0;
  const frames: Frame[] = [];
  const active = new WeakSet<object>();
  const visit = (value: unknown) => {
    if (frames.length >= MAX_DEPTH) throw new LogbirdError('input_too_deep');
    bytes += lowerBound(value);
    if (value && typeof value === 'object') {
      if (active.has(value)) throw new LogbirdError('event_invalid');
      if (Array.isArray(value) && value.length) bytes += value.length - 1;
      active.add(value);
      frames.push({ value, members: members(value, frames.length === 0), first: true });
    }
    if (bytes > MAX_INPUT_BYTES) throw new LogbirdError('input_too_large');
  };
  visit(root);
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
      if (value === undefined || typeof value === 'symbol' || typeof value === 'function') continue;
      bytes += key.length + 3 + Number(!frame.first);
      frame.first = false;
    }
    visit(value);
  }
}

type Replacer = (this: object, key: string, value: unknown) => unknown;

/** Check values exposed by toJSON before the serializer expands their strings or descends into them. */
export function stringifyEvent(event: unknown, replace?: Replacer): string {
  let remaining = MAX_INPUT_BYTES;
  const depth = new WeakMap<object, number>();
  return JSON.stringify(event, function guarded(this: object, key, value: unknown) {
    const level = (depth.get(this) ?? -1) + 1;
    if (level >= MAX_DEPTH) throw new LogbirdError('input_too_deep');
    const transformed = replace ? replace.call(this, key, value) : value;
    if (transformed && typeof transformed === 'object') depth.set(transformed, level);
    // Account even for omitted values so dynamically generated objects cannot cause an unbounded walk.
    remaining -= key.length + Math.max(lowerBound(value), lowerBound(transformed));
    if (remaining < 0) throw new LogbirdError('input_too_large');
    return transformed;
  });
}
