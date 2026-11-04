/** Stable keys for skeleton/placeholder lists (avoids index keys). */
export function placeholderKeys(count: number, prefix = 'placeholder'): string[] {
  return Array.from({ length: count }, (_, n) => `${prefix}-${n}`);
}
