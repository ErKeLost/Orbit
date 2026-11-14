/**
 * The pipe between ElevenLabs and the desktop. No Pi process lives here.
 *
 * A turn is queued until the desktop posts the words to speak. An announcement
 * is not a turn: the prefix is spoken back as-is, and the desktop is told it
 * was spoken so it does not play a second mouth.
 */
export const ANNOUNCE_PREFIX = "orbit:announce:"
export const DESK_MISSING = "桌面没接上，这句不会派活。"

export function announcementOf(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(ANNOUNCE_PREFIX)) return null
  const sentence = trimmed.slice(ANNOUNCE_PREFIX.length).trim()
  return sentence || null
}

export function withoutAnnouncements<T extends { role: string; content?: string }>(transcript: T[]): T[] {
  return transcript.filter(message => message.role !== "user" || announcementOf(message.content ?? "") === null)
}

type Waiter<T> = { resolve: (value: T) => void; timer: ReturnType<typeof setTimeout> }

export class Desk {
  attached = false
  private queue: Array<{ id: string; said: string; heard: string }> = []
  private pending = new Map<string, { push: (text: string) => void; finish: () => void }>()
  private nextWaiter: Waiter<{ id: string; said: string; heard: string } | null> | null = null
  private spokenWaiters: Waiter<string | null>[] = []

  hello() {
    this.attached = true
  }

  enqueue(said: string, heard: string, signal: AbortSignal): { id: string; spoken: AsyncGenerator<string> } {
    const id = crypto.randomUUID()
    const chunks: string[] = []
    let done = false
    let wake: (() => void) | null = null
    const poke = () => {
      wake?.()
      wake = null
    }
    this.pending.set(id, {
      push: text => {
        if (done || signal.aborted || !text) return
        chunks.push(text)
        poke()
      },
      finish: () => {
        done = true
        poke()
      },
    })
    const onAbort = () => {
      done = true
      poke()
    }
    signal.addEventListener("abort", onAbort, { once: true })
    this.queue.push({ id, said, heard })
    this.nextWaiter?.resolve(this.queue.shift() ?? null)
    this.nextWaiter = null
    const pending = this.pending
    const spoken = (async function* () {
      const deadline = Date.now() + 45_000
      let yielded = false
      try {
        while (!signal.aborted && Date.now() < deadline) {
          if (!chunks.length && !done) await new Promise<void>(resolve => { wake = resolve })
          while (chunks.length) {
            yielded = true
            yield chunks.shift() as string
          }
          if (done) return
        }
        if (!signal.aborted && !yielded) yield "\u8fd9\u53e5\u6ca1\u6709\u7b54\u4e0a\u3002"
      } finally {
        signal.removeEventListener("abort", onAbort)
        pending.delete(id)
      }
    })()
    return { id, spoken }
  }

  next(timeoutMs: number): Promise<{ id: string; said: string; heard: string } | null> {
    this.attached = true
    const ready = this.queue.shift()
    if (ready) return Promise.resolve(ready)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.nextWaiter) this.nextWaiter = null
        resolve(null)
      }, timeoutMs)
      this.nextWaiter = {
        timer,
        resolve: value => {
          clearTimeout(timer)
          this.nextWaiter = null
          resolve(value)
        },
      }
    })
  }

  chunk(id: string, text: string) {
    this.pending.get(id)?.push(text)
  }

  end(id: string) {
    const turn = this.pending.get(id)
    turn?.finish()
    this.pending.delete(id)
  }

  spoke(text: string) {
    const waiters = this.spokenWaiters.splice(0)
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve(text)
    }
  }

  waitSpoken(timeoutMs: number): Promise<string | null> {
    return new Promise(resolve => {
      const waiter: Waiter<string | null> = {
        resolve,
        timer: setTimeout(() => {
          this.spokenWaiters = this.spokenWaiters.filter(item => item !== waiter)
          resolve(null)
        }, timeoutMs),
      }
      this.spokenWaiters.push(waiter)
    })
  }
}
