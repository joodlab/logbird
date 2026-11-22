/**
 * Writes a search box's text to the URL after the reader pauses typing, without ever overriding a navigation.
 *
 * Every edit schedules its own write (so pasting the same text again still commits), remembering the location it
 * started from. When the timer fires, the write happens only if the location is still that one: Back/Forward, a range
 * change or any other navigation in between wins, and the edit is dropped. `takePending()` hands over unwritten text
 * (a chip click folds it into its own change instead of losing it).
 */
export interface SearchCommitter {
  edit(text: string): void;
  /** The text still waiting to be written, if any, and cancel its write. */
  takePending(): string | undefined;
  cancel(): void;
  readonly pending: string | undefined;
}

export function createSearchCommitter(options: { wait: number; location: () => string; commit: (text: string) => void }): SearchCommitter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { text: string; from: string } | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  return {
    edit(text) {
      // The edit belongs to the location the reader was looking at when they started typing.
      const from = pending?.from ?? options.location();
      if (timer !== undefined) clearTimeout(timer);
      pending = { text, from };
      timer = setTimeout(() => {
        const p = pending;
        timer = undefined;
        pending = undefined;
        if (p && options.location() === p.from) options.commit(p.text);
      }, options.wait);
    },
    takePending() {
      const text = pending?.text;
      cancel();
      return text;
    },
    cancel,
    get pending() {
      return pending?.text;
    },
  };
}
