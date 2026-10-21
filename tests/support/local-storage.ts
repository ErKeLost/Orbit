/**
 * One functional in-memory `localStorage` for every suite `bun test` runs in
 * this process.
 *
 * Bun runs the whole `tests/` directory in a single process, and the first file
 * to install a mock used to win: each suite wrote `globals.localStorage ??= …`,
 * so a no-op mock installed by an unrelated suite (the screen tests only need
 * the API to exist) silently swallowed `launch-defaults`' writes. The runner
 * visits files in whatever order the filesystem hands them over, so that race
 * passed locally and failed on CI — and adding a test file was enough to flip
 * it.
 *
 * A suite that needs storage now gets the same real store wherever it runs,
 * and the one suite that reads back what it wrote clears it first.
 */

const INSTALLED = Symbol.for("orbit.tests.local-storage")

export type MemoryStorage = {
  readonly entries: Map<string, string>
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
  clear: () => void
}

export function installMemoryLocalStorage(): MemoryStorage {
  const existing = (globalThis as { localStorage?: Partial<MemoryStorage> }).localStorage
  if (existing && (existing as unknown as Record<symbol, unknown>)[INSTALLED]) {
    return existing as MemoryStorage
  }
  const entries = new Map<string, string>()
  const storage: MemoryStorage = {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, String(value)) },
    removeItem: (key) => { entries.delete(key) },
    clear: () => { entries.clear() },
  }
  Object.defineProperty(storage, INSTALLED, { value: true })
  // Replaces whatever an earlier suite left behind: a store that only no-ops
  // is worse than none, because writes look successful and vanish.
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: storage })
  return storage
}
