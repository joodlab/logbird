/** First human-readable message from a TanStack Form field's error list (strings or Standard Schema issues). */
export function fieldErrorMessage(errors: readonly unknown[]): string | undefined {
  for (const error of errors) {
    if (!error) continue;
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
      return (error as { message: string }).message;
    }
  }
  return undefined;
}
