import { spawn } from "node:child_process"
import { resolveCuaDriver } from "./binary.ts"
import { DriverToolError } from "./errors.ts"
import type { ToolResult } from "./tool-result.ts"

/**
 * Transport to Cua Driver: one `cua-driver call <tool> '<json>'` process per
 * action, JSON in / JSON out.
 *
 * A refusal is not a transport failure. The CLI exits non-zero and prints a
 * structured refusal on stdout, in one of two shapes:
 *
 *   { "refusal": { "code", "message" }, "status": "refused" }        tool-level
 *   { "code", "effect": "refused", "escalation": { … } }             action-level
 *
 * Both become a `DriverToolError` so the loop can read the code and — crucially
 * — the `escalation` rung the driver recommends next. Collapsing either into a
 * plain Error is what made every refusal look like an unknown failure.
 *
 * State that must outlive one process — element tokens, capture ids — is kept
 * by the daemon under a `session` label this client repeats on every call.
 */

export type CuaToolClientOptions = {
  signal?: AbortSignal
  /** Daemon socket; omitted uses the CuaDriver.app daemon. */
  socket?: string
  /** Public run label so the daemon keeps tokens/captures across CLI calls. */
  session?: string
  /** Inject `session` into tools that accept it. Default true. */
  injectSession?: boolean
}

export interface CuaToolClient {
  readonly transport: "cli"
  readonly session?: string
  listTools(): Promise<string[]>
  call(name: string, args?: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ToolResult>
  dispose(): Promise<void>
}

/** The only tool without a `session` field; sending it one is a 400. */
export const NO_SESSION_TOOLS = new Set(["list_sessions"])

const DEFAULT_TIMEOUT_MS = 20_000

export async function createCliClient(options: CuaToolClientOptions = {}): Promise<CuaToolClient> {
  const session = options.session ?? `orbit-${process.pid.toString(36)}-${Date.now().toString(36)}`
  const injectSession = options.injectSession !== false
  let disposed = false

  const baseArgs = ["call"]
  if (options.socket) baseArgs.push("--socket", options.socket)

  return {
    transport: "cli",
    session,
    async listTools() {
      // `cua-driver list-tools` prints `name: description` per line.
      const args = ["list-tools", ...(options.socket ? ["--socket", options.socket] : [])]
      const run = await exec(args, { signal: options.signal, timeoutMs: 20_000 })
      return run.stdout.split("\n").map(line => line.split(":")[0].trim()).filter(Boolean)
    },
    async call(name, args = {}, callOptions = {}) {
      if (disposed) throw new Error("cua-driver client disposed")
      const payload = buildCallPayload(name, args, session, injectSession)
      const run = await exec([...baseArgs, name, JSON.stringify(payload)], {
        signal: callOptions.signal ?? options.signal,
        timeoutMs: callOptions.timeoutMs,
      })
      return parseToolResult(name, run)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      // Release the named session so the daemon drops its snapshots and
      // capture registry promptly instead of waiting for the idle TTL.
      try {
        await exec([...baseArgs, "end_session", JSON.stringify({ session })], { timeoutMs: 3_000 })
      } catch { /* best effort */ }
    },
  }
}

/**
 * The exact JSON `cua-driver call` receives. The session label is what makes
 * element tokens and capture ids survive across one-process-per-call, so it is
 * added only for tools that declare the field.
 */
export function buildCallPayload(
  tool: string,
  args: Record<string, unknown>,
  session: string | undefined,
  injectSession: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...args }
  if (injectSession && session && !NO_SESSION_TOOLS.has(tool) && payload.session === undefined) payload.session = session
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))
}

export type RunResult = { stdout: string; stderr: string; code: number | null }

/**
 * Turn one CLI run into a `ToolResult`, or a `DriverToolError` when the driver
 * refused. A non-zero exit with a structured refusal is the normal refusal
 * path, not an error to hide.
 */
export function parseToolResult(tool: string, run: RunResult): ToolResult {
  const stdout = run.stdout.trim()
  const parsed = parseJson(stdout) ?? parseJson(run.stderr.trim())
  const refusal = parsed ? parseRefusal(parsed) : undefined
  if (refusal) throw new DriverToolError(tool, refusal.code, refusal.message, refusal.retryable, parsed ?? {})
  if (run.code !== 0) {
    const detail = (run.stderr.trim() || stdout).slice(0, 400)
    throw new Error(`cua-driver call ${tool} exited ${run.code}: ${detail || "no output"}`)
  }
  if (!parsed) return { value: {}, text: stdout, images: [], isError: false }
  return { value: parsed, text: stdout, images: [], isError: false }
}

/** Both refusal shapes the driver emits, reduced to one. */
export function parseRefusal(value: Record<string, unknown>): { code: string; message: string; retryable: boolean } | undefined {
  const nested = value.refusal && typeof value.refusal === "object" ? value.refusal as Record<string, unknown> : undefined
  const code = typeof value.code === "string" ? value.code : typeof nested?.code === "string" ? nested.code : undefined
  if (!code) return undefined
  const message = typeof value.message === "string"
    ? value.message
    : typeof nested?.message === "string" ? nested.message : "the driver refused the request"
  const retryable = value.retryable === true || nested?.retryable === true
  return { code, message, retryable }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) return undefined
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function exec(args: string[], options: { signal?: AbortSignal; timeoutMs?: number }): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    resolveCuaDriverBinary().then(binary => {
      const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
        fn()
      }
      const onAbort = () => { child.kill("SIGKILL"); finish(() => reject(new Error("cua-driver call aborted"))) }
      child.stdout.on("data", chunk => { stdout += String(chunk) })
      child.stderr.on("data", chunk => { stderr += String(chunk) })
      child.on("error", error => finish(() => reject(error)))
      child.on("close", code => finish(() => resolvePromise({ stdout, stderr, code })))
      options.signal?.addEventListener("abort", onAbort, { once: true })
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        finish(() => reject(new Error(`cua-driver ${args[1] ?? "call"} timed out after ${timeoutMs}ms`)))
      }, timeoutMs)
      timer.unref?.()
    }, reject)
  })
}

// Resolution walks the filesystem once per run, not once per action.
let binaryMemo: Promise<string> | undefined
function resolveCuaDriverBinary(): Promise<string> {
  binaryMemo ??= resolveCuaDriver()
  return binaryMemo
}
