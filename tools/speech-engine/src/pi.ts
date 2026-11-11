/**
 * One Pi process per voice conversation, driven over `pi --mode rpc`.
 *
 * The wire format is the same JSONL the desktop app already speaks: commands in on
 * stdin (`{id,type,...}`), responses and events out on stdout. Responses are matched
 * by id; assistant text arrives as `message_update.assistantMessageEvent.text_delta`.
 *
 * Speech Engine sends the full transcript every turn, but Pi keeps its own history,
 * so we only forward the newest user message and never replay the transcript.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

export type PiOptions = {
  /** Working directory the agent operates in. */
  cwd: string
}

const VOICE_RULES = [
  "You are talking to the user out loud through a phone-quality voice channel.",
  "Answer in the language the user used. Reply with one or two short sentences, never more than 60 words.",
  "Lead with the result, blocker or the single question you need answered.",
  "Never read out code, file paths, logs, URLs, tables or lists; put long output in a file and say what you did.",
  "Do not narrate your reasoning or the tools you are about to use.",
].join(" ")

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

export class PiVoice {
  private child: ChildProcessWithoutNullStreams
  private pending = new Map<string, Pending>()
  private deltas = new Set<(text: string) => void>()
  private settled = new Set<(error?: Error) => void>()
  private counter = 0
  private closed = false
  private stderrTail: string[] = []

  constructor(options: PiOptions) {
    // No model, thinking level or tool list of our own: Pi uses whatever the app is
    // configured with, exactly like a normal session. The only thing added is a
    // reminder that the answer is spoken out loud.
    const args = ["--mode", "rpc", "--offline", "--append-system-prompt", VOICE_RULES]
    this.child = spawn("pi", args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_CODING_AGENT: "true" },
    })

    const lines = createInterface({ input: this.child.stdout })
    lines.on("line", line => this.receive(line))

    const errors = createInterface({ input: this.child.stderr })
    errors.on("line", line => {
      this.stderrTail = [...this.stderrTail.slice(-19), line]
    })

    this.child.on("exit", (code, signal) => {
      this.closed = true
      const detail = this.stderrTail.join(" | ").slice(0, 400)
      const error = new Error(`pi exited (${code ?? signal ?? "signal"})${detail ? `: ${detail}` : ""}`)
      for (const [, pending] of this.pending) pending.reject(error)
      this.pending.clear()
      for (const settle of this.settled) settle(error)
      this.settled.clear()
    })
  }

  private receive(line: string) {
    let value: Record<string, unknown>
    try {
      value = JSON.parse(line)
    } catch {
      return
    }
    if (value.type === "response" && typeof value.id === "string") {
      const pending = this.pending.get(value.id)
      if (!pending) return
      this.pending.delete(value.id)
      if (value.success) pending.resolve(value.data)
      else pending.reject(new Error(messageOf(value.error)))
      return
    }
    if (value.type === "message_update") {
      const delta = value.assistantMessageEvent as { type?: string; delta?: string } | undefined
      if (delta?.type === "text_delta" && delta.delta) for (const emit of this.deltas) emit(delta.delta)
      return
    }
    if (value.type === "agent_settled") {
      for (const settle of this.settled) settle()
      this.settled.clear()
    }
  }

  private send(command: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("pi 进程已经退出"))
    const id = `se-${++this.counter}`
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`pi 响应超时（${String(command.type)}）`))
      }, timeoutMs).unref?.()
    })
    this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`)
    return promise
  }

  /** Send one user utterance and stream everything Pi says back. */
  prompt(text: string, signal: AbortSignal): AsyncIterable<string> {
    const queue: string[] = []
    let done = false
    let error: Error | undefined
    let wake: (() => void) | undefined
    const flush = () => {
      wake?.()
      wake = undefined
    }
    const emit = (token: string) => {
      queue.push(token)
      flush()
    }
    const settle = (failure?: Error) => {
      error = failure
      done = true
      flush()
    }
    this.deltas.add(emit)
    this.settled.add(settle)
    const cleanup = () => {
      this.deltas.delete(emit)
      this.settled.delete(settle)
    }
    void this.send({ type: "prompt", message: text }, 30_000).catch(settle)
    const stop = () => void this.abort().catch(() => undefined)
    signal.addEventListener("abort", stop, { once: true })

    const iterator: AsyncIterator<string> = {
      next: async () => {
        for (;;) {
          if (queue.length) return { value: queue.shift()!, done: false }
          if (done) {
            cleanup()
            signal.removeEventListener("abort", stop)
            if (queue.length) return { value: queue.shift()!, done: false }
            return error && !signal.aborted ? { value: `pi 停止：${error.message}`, done: false } : { value: undefined, done: true }
          }
          await new Promise<void>(resolve => {
            wake = resolve
            setTimeout(resolve, 250)
          })
        }
      },
    }
    return { [Symbol.asyncIterator]: () => iterator }
  }

  async abort() {
    if (this.closed) return
    await this.send({ type: "abort" }, 8_000).catch(() => undefined)
  }

  dispose() {
    if (this.closed) return
    this.closed = true
    this.child.stdin.end()
    this.child.kill("SIGTERM")
  }
}

function messageOf(value: unknown): string {
  if (typeof value === "string") return value
  if (value && typeof value === "object" && "message" in value) return String((value as { message: unknown }).message)
  return JSON.stringify(value).slice(0, 300)
}
