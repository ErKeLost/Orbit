/** A cancelled or timed-out attempt must settle even if a device API never does. */
export function waitForStartup<T>(operation: Promise<T>, signal: AbortSignal, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer); signal.removeEventListener("abort", abort)
      if (error !== undefined) reject(error); else resolve(value as T)
    }
    const abort = () => finish(new DOMException("Aborted", "AbortError"))
    const timer = setTimeout(() => finish(new Error(message)), timeoutMs)
    signal.addEventListener("abort", abort, { once: true })
    operation.then(value => finish(undefined, value), error => finish(error))
    if (signal.aborted) abort()
  })
}
