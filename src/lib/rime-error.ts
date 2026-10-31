export type RimeFailure = {
  kind: string
  message: string
  retryable: boolean
  requestId?: string
  httpStatus?: number
}

export class RimeApiError extends Error {
  readonly kind: string
  readonly retryable: boolean
  readonly requestId?: string
  readonly httpStatus?: number
  constructor(failure: RimeFailure) {
    super(failure.message)
    this.name = "RimeApiError"
    this.kind = failure.kind
    this.retryable = failure.retryable
    this.requestId = failure.requestId
    this.httpStatus = failure.httpStatus
  }
}

export function rimeError(error: unknown): RimeApiError {
  if (error instanceof RimeApiError) return error
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    const failure = error as Partial<RimeFailure> & { message: string }
    return new RimeApiError({ ...failure, message: failure.message, kind: failure.kind ?? "transport", retryable: failure.retryable ?? true })
  }
  return new RimeApiError({ message: String(error), kind: "transport", retryable: true })
}

export function rimeErrorMessage(error: unknown): string {
  const failure = rimeError(error)
  return failure.requestId ? `${failure.message}（请求 ${failure.requestId}）` : failure.message
}
