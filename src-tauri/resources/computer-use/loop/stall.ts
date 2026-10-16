/**
 * Stall detection.
 *
 * Nothing in an action's return value says what came of it; only the successor
 * observation does. These rules are the brake the previous engine lacked:
 *
 * - three delivered actions in a row that left the screen as it was, or
 * - two actions already taken on this same screen earlier in the run.
 *
 * Two screens are the same when at most one observed line differs, so a clock
 * or a progress ticker does not hide a stall, and a one-line modal is not
 * mistaken for "nothing happened".
 */

const SIGNATURE_LINES = 120

/** The comparable part of a screen: one line per observed element. */
export function screenLines(lines: readonly string[]): string[] {
  return lines.slice(0, SIGNATURE_LINES)
}

/** True when at most one line differs between two observations of a screen. */
export function sameScreen(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(screenLines(left))
  const b = new Set(screenLines(right))
  let onlyLeft = 0
  for (const line of a) if (!b.has(line)) onlyLeft++
  let onlyRight = 0
  for (const line of b) if (!a.has(line)) onlyRight++
  // One line replaced is one difference, not two.
  return Math.max(onlyLeft, onlyRight) <= 1
}

export type StallVerdict = { stalled: true; reason: string } | { stalled: false }

export class StallTracker {
  private noChangeStreak = 0
  private repeatStreak = 0
  /** Screens previously acted on, each with the action keys already taken. */
  private readonly screens: Array<{ lines: string[]; actions: Set<string> }> = []

  /**
   * Record one delivered action and the screen it produced.
   * `after` is the successor observation; `before` the one the action was chosen from.
   */
  record(actionKey: string, before: readonly string[], after: readonly string[]): StallVerdict {
    const changed = !sameScreen(before, after)
    this.noChangeStreak = changed ? 0 : this.noChangeStreak + 1

    const screen = this.findScreen(before)
    const repeated = screen ? screen.actions.has(actionKey) : false
    this.repeatStreak = repeated ? this.repeatStreak + 1 : 0

    const target = screen ?? this.openScreen(before)
    target.actions.add(actionKey)

    if (this.noChangeStreak >= 3) {
      return { stalled: true, reason: "three delivered actions in a row left the screen unchanged" }
    }
    // A second attempt at the same action on a screen that did not move is a
    // loop, not progress: the recorded failure repeated one row eight times.
    if (repeated) {
      return { stalled: true, reason: "the same action was taken twice on this unchanged screen" }
    }
    return { stalled: false }
  }

  /** A fresh observation that differs from every remembered screen starts a new one. */
  private openScreen(lines: readonly string[]): { lines: string[]; actions: Set<string> } {
    const entry = { lines: screenLines(lines), actions: new Set<string>() }
    this.screens.push(entry)
    if (this.screens.length > 40) this.screens.shift()
    return entry
  }

  private findScreen(lines: readonly string[]): { lines: string[]; actions: Set<string> } | undefined {
    return this.screens.find(screen => sameScreen(screen.lines, lines))
  }
}

/**
 * The repeat brake for one target chosen over and over.
 *
 * The recorded failure was `DOUBLE_CLICK` on one row eight times: the tree
 * oscillated between two fingerprints, so every step looked like progress and
 * the unchanged counter never accumulated. Counting selections of the same
 * stable target catches it regardless of what the fingerprint does.
 */
export class RepeatBrake {
  private lastIdentity?: string
  private streak = 0
  private readonly exhausted = new Set<string>()

  /** How many identical selections in a row before the target is withheld. */
  constructor(private readonly limit = 2) {}

  observe(identity: string | undefined): void {
    if (!identity) return
    if (identity === this.lastIdentity) {
      this.streak += 1
      if (this.streak >= this.limit) this.exhausted.add(identity)
    } else {
      this.lastIdentity = identity
      this.streak = 1
    }
  }

  /** Called after any step that changed the screen: a new screen resets the run. */
  reset(): void {
    this.lastIdentity = undefined
    this.streak = 0
  }

  get blocked(): ReadonlySet<string> {
    return this.exhausted
  }
}
