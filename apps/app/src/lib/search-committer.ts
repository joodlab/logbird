/**
 * Writes a search box's text to the URL after the reader pauses typing, without ever overriding a navigation.
 *
 * Every edit schedules its own write (so pasting the same text again still commits), remembering the history entry it
 * started on. When the timer fires, the write happens only if the reader is still on that entry: Back/Forward or a new
 * entry (a link, a range picked from the header) in between wins, and the edit is dropped. The page's own writes replace
 * the current entry, so they never count as a move: an edit begun while an earlier write is landing still commits. `takePending()` hands over unwritten text
 * (a chip click folds it into its own change instead of losing it).
 */
export interface SearchCommitter {
  edit(text: string): void;
  /** The text still waiting to be written, if any, and cancel its write. */
  takePending(): string | undefined;
  cancel(): void;
  readonly pending: string | undefined;
}

export function createSearchCommitter(options: { wait: number; entry: () => string; commit: (text: string) => void }): SearchCommitter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { text: string; from: string } | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  return {
    edit(text) {
      // The edit belongs to the history entry the reader was on when they started typing.
      const from = pending?.from ?? options.entry();
      if (timer !== undefined) clearTimeout(timer);
      pending = { text, from };
      timer = setTimeout(() => {
        const p = pending;
        timer = undefined;
        pending = undefined;
        if (p && options.entry() === p.from) options.commit(p.text);
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
