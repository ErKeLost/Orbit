/**
 * Which runtime failures are worth putting on screen.
 *
 * The 2s/5s heartbeat in `metrics.tsx` talks to a pi process through the Rust
 * bridge. That bridge answers `项目尚未连接` for exactly one situation: the
 * registry has no worker under the id the command was routed to — the process
 * exited, was replaced by a session switch, or has not finished starting. All
 * three repair themselves, so treating them as an error banner misleads the
 * user; a heartbeat that keeps failing is the real signal.
 */

/** The bridge's wording when no pi worker is registered for the project. */
const NOT_CONNECTED = '项目尚未连接'

/** A heartbeat failure that means "there is no process right now", not "this is broken". */
export const projectDisconnected = (error: unknown) =>
  String(error instanceof Error ? error.message : error).includes(NOT_CONNECTED)

/**
 * How many consecutive heartbeat failures to swallow before showing anything.
 *
 * One failed poll is a reconnect in progress (~5s); two in a row is already ten
 * seconds without a live SDK, which is what a user would want to know about.
 */
export const QUIET_FAILED_POLLS = 2

/**
 * The text to render, or `null` to stay quiet.
 *
 * `failedPolls` is react-query's `failureCount`: it resets on the next success,
 * so it measures "consecutive failures" exactly, without extra state.
 */
export function runtimeErrorToShow(error: unknown, failedPolls: number): string | null {
  if (error === null || error === undefined) return null
  if (projectDisconnected(error) && failedPolls < QUIET_FAILED_POLLS) return null
  return String(error)
}
