/** A structured refusal or failure from one Cua Driver tool call. */
export class DriverToolError extends Error {
  constructor(
    readonly tool: string,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly payload: Record<string, unknown>,
  ) {
    super(`${tool} failed (${code}): ${message}`)
    this.name = "DriverToolError"
  }
}

/** The next rung the driver recommends after a background refusal. */
export type EscalationRung = "px" | "page" | "foreground"

/**
 * Read the rung out of a refusal. The driver's contract is that a background
 * refusal is never retried in the foreground implicitly — the caller must offer
 * the next rung as a *separate* candidate. This is how the loop learns which
 * one to offer.
 */
export function escalationOf(error: unknown): EscalationRung | undefined {
  if (!(error instanceof DriverToolError)) return undefined
  const raw = error.payload.escalation
  if (!raw || typeof raw !== "object") return undefined
  const recommended = (raw as Record<string, unknown>).recommended
  return recommended === "px" || recommended === "page" || recommended === "foreground" ? recommended : undefined
}

/** The Cua Driver executable or its grants are missing. */
export class DriverUnavailableError extends Error {
  constructor(
    message: string,
    readonly code: "DRIVER_UNAVAILABLE" | "DRIVER_NOT_GRANTED",
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = "DriverUnavailableError"
  }
}
