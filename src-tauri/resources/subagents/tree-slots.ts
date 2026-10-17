import { closeSync, mkdirSync, openSync, readdirSync, rmdirSync, unlinkSync, writeSync } from "node:fs"
import { join } from "node:path"

/**
 * A tree-wide budget on concurrently running workers.
 *
 * Codex enforces one limit across the whole session tree, because a nested
 * supervisor that multiplies `MAX_ACTIVE_CHILDREN` per level is how a delegation
 * loop turns into hundreds of processes. Orbit's workers are separate processes,
 * so the only shared state is the filesystem: each running worker owns one slot
 * file under the tree directory, and a spawn has to claim one.
 *
 * Claiming is over-claim-then-verify, which is safe under races: every claimant
 * creates its file with `O_EXCL`, recounts, and backs off if the recount is over
 * budget. Two simultaneous claims can make both back off — never both win.
 *
 * A slot names its owner's pid, so a crashed process leaves a slot that the next
 * claim reclaims instead of shrinking the tree budget forever.
 */
export class TreeSlots {
  /** Directory holding one file per running worker. Read-only for callers. */
  readonly dir: string
  private readonly limit: number
  private readonly owned = new Set<string>()

  constructor(dir: string, limit: number) {
    this.dir = join(dir, "slots")
    this.limit = Math.max(1, Math.floor(limit))
  }

  get budget(): number {
    return this.limit
  }

  /** Reserve one slot, or throw a message the model can act on. */
  acquire(): string {
    mkdirSync(this.dir, { recursive: true })
    const live = this.prune()
    if (live >= this.limit) {
      throw new Error(
        `整棵 agent 树的并发已满：最多 ${this.limit} 个子 agent 同时运行（当前 ${live} 个）。` +
          `等一个结束、或用 wait_agent 等结果后再派。`,
      )
    }
    const file = join(this.dir, `${process.pid}-${Math.random().toString(36).slice(2, 10)}`)
    const fd = openSync(file, "wx")
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
    } finally {
      closeSync(fd)
    }
    this.owned.add(file)
    // Verify: someone else may have claimed between the count and the create.
    if (this.prune({ countOnly: true }) > this.limit) {
      this.release(file)
      throw new Error(
        `整棵 agent 树的并发已满：最多 ${this.limit} 个子 agent 同时运行。等一个结束后再派。`,
      )
    }
    return file
  }

  /** Give a slot back. Idempotent, and never throws. */
  release(file: string): void {
    this.owned.delete(file)
    try {
      unlinkSync(file)
    } catch {
      /* already gone; a crash cleaner or another process reclaimed it */
    }
  }

  /** Give back every slot this process still holds (used on shutdown). */
  releaseAll(): void {
    for (const file of [...this.owned]) this.release(file)
  }

  /**
   * Drop slots whose owner is gone and return how many are still held. With
   * `countOnly` the caller wants the number without deleting foreign live slots.
   */
  private prune(options: { countOnly?: boolean } = {}): number {
    let held = 0
    let entries: string[]
    try {
      entries = readdirSync(this.dir)
    } catch {
      return 0
    }
    for (const entry of entries) {
      const file = join(this.dir, entry)
      const pid = Number(entry.split("-", 1)[0])
      if (!Number.isFinite(pid) || pid <= 0) {
        if (!options.countOnly) this.drop(file)
        continue
      }
      if (pid !== process.pid && !isAlive(pid)) {
        if (!options.countOnly) this.drop(file)
        continue
      }
      held += 1
    }
    return held
  }

  private drop(file: string): void {
    try {
      unlinkSync(file)
    } catch {
      /* raced with its owner's release */
    }
  }

  /** Remove the slot directory when it is empty. `rmdir` fails on a non-empty
   * directory, which is what keeps a disposing worker from deleting a sibling's
   * live slot. */
  dispose(): void {
    this.releaseAll()
    try {
      rmdirSync(this.dir)
    } catch {
      /* not empty: siblings are still running */
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 probes liveness without touching the target.
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException)?.code === "EPERM"
  }
}
