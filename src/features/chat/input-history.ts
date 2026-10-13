/**
 * Shell-style input history for the composer.
 *
 * The awkward part is not fetching the entries but stepping through them, so it
 * lives here as a pure function: the component only has to decide *when* an
 * arrow key means "history" rather than "move the caret".
 */

export type HistoryStep = {
  /** Index into the history, oldest first. `null` means "not browsing". */
  index: number | null;
  /** Put the reader's own draft back instead of a history entry. */
  restore: boolean;
};

/**
 * Step one entry through history.
 *
 * - `up` from "not browsing" enters at the newest entry.
 * - `up` at the oldest entry is a no-op (returns `null`) so the key is swallowed
 *   rather than falling through to the caret.
 * - `down` past the newest entry leaves history and asks for the stashed draft.
 * - `down` while not browsing is not history (returns `null`).
 *
 * Returns `null` whenever the key should not be treated as history navigation.
 */
export function stepInputHistory(
  length: number,
  index: number | null,
  direction: "up" | "down",
): HistoryStep | null {
  if (length <= 0) return null;
  if (direction === "up") {
    if (index === null) return { index: length - 1, restore: false };
    if (index <= 0) return null;
    return { index: index - 1, restore: false };
  }
  if (index === null) return null;
  if (index + 1 >= length) return { index: null, restore: true };
  return { index: index + 1, restore: false };
}

/** The reader's sent messages, oldest first, as plain text. */
export function inputHistoryEntries(messages: readonly { message: { role: string } }[], text: (message: never) => string): string[] {
  return messages
    .filter((item) => item.message.role === "user")
    .map((item) => text(item.message as never).trim())
    .filter((entry) => entry.length > 0);
}
