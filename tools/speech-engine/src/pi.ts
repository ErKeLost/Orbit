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

    // `spawn` 失败（PATH 里没有 pi、shim 被删）只会异步发一个 'error' 事件；不接住它
    // 就会变成未捕获异常，把这整个服务端进程带走。
    this.child.on("error", error => {
      this.closed = true
      for (const [, pending] of this.pending) pending.reject(error)
      this.pending.clear()
      for (const settle of this.settled) settle(error)
      this.settled.clear()
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
    // A single RPC line is one event. Anything past a few MB is a tool payload we are
    // never going to speak out loud, and parsing it in one go is exactly the kind of
    // spike that can take this process from 130 MB to gigabytes. Drop it, say so.
    if (line.length > 8 * 1024 * 1024) {
      console.warn(`[pi] dropped a ${Math.round(line.length / 1024 / 1024)}MB rpc line`)
      return
    }
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
    let disposed = false
    let error: Error | undefined
    let wake: (() => void) | undefined
    const flush = () => {
      wake?.()
      wake = undefined
    }
    const emit = (token: string) => {
      // A consumer that walked away (call dropped mid-answer) must not keep growing
      // its queue: the text would accumulate with nothing to drain it.
      if (disposed) return
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
      disposed = true
      queue.length = 0
      this.deltas.delete(emit)
      this.settled.delete(settle)
      signal.removeEventListener("abort", stop)
    }
    // `steer`：通话中用户开口就是插话，pi 会把这句话并进正在跑的回合，而不是
    // 直接回一句“已经忙着了”。不传这个字段，边说话边回答就会变成一条报错气泡。
    void this.send({ type: "prompt", message: text, streamingBehavior: "steer" }, 30_000).catch(settle)
    const stop = () => void this.abort().catch(() => undefined)
    signal.addEventListener("abort", stop, { once: true })

    const iterator: AsyncIterator<string> = {
      next: async () => {
        for (;;) {
          if (queue.length) return { value: queue.shift()!, done: false }
          if (disposed) return { value: undefined, done: true }
          if (done) {
            const failure = error && !signal.aborted ? `pi 停止：${error.message}` : undefined
            cleanup()
            return failure && !queue.length ? { value: failure, done: false } : { value: undefined, done: true }
          }
          await new Promise<void>(resolve => {
            wake = resolve
            setTimeout(resolve, 250)
          })
        }
      },
      // Called by the SDK when a response is superseded (barge-in) or the call ends.
      return: async () => {
        cleanup()
        return { value: undefined, done: true }
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
