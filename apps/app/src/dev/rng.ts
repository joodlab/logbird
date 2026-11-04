/** Deterministic PRNG (mulberry32) + helpers. Fixture data must be stable across reloads. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d_2b_79_f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('pick() on empty list');
    return item;
  }

  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((sum, [, w]) => sum + w, 0);
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r <= 0) return item;
    }
    const last = items.at(-1);
    if (!last) throw new Error('weighted() on empty list');
    return last[0];
  }

  /** Exponential inter-arrival time with the given mean. */
  exp(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }

  hex(len: number): string {
    let s = '';
    for (let i = 0; i < len; i++) s += Math.floor(this.next() * 16).toString(16);
    return s;
  }

  alnum(len: number): string {
    const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(this.next() * chars.length)];
    return s;
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID: 48-bit time + 80 bits of (seeded) randomness, lexicographically sortable. */
export function ulid(timeMs: number, rng: Rng): string {
  let time = '';
  let t = Math.floor(timeMs);
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(rng.next() * 32)];
  return time + rand;
}
