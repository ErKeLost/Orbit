import { LazyStore } from "@tauri-apps/plugin-store"

/**
 * Durable storage for the few values whose loss actually hurts.
 *
 * `localStorage` lives in the WebView's own storage area. It survives restarts,
 * but it is the renderer's data: the system clears it under storage pressure,
 * and "clear cache" and "clear app data" take it with them. Losing a pairing URI
 * there means walking to the computer and re-pairing by hand, and losing the
 * mobile-access intent means the phone cannot come back on its own.
 *
 * # Why this is a mirror and not a replacement
 *
 * Every reader of these values is synchronous — the pairing URI is read while
 * React builds its first state, and the screen preferences during render.
 * `plugin-store` is asynchronous, so making it the only source would mean making
 * the whole app's initial state async, which is a rewrite far larger than the
 * problem. Instead:
 *
 * * **writes** go to both, so the durable copy is always current;
 * * **reads** stay on `localStorage`, unchanged and synchronous;
 * * **startup** copies the durable copy back in, so a cleared WebView storage
 *   is repaired rather than noticed.
 *
 * The plugin owns the file; this module only decides which keys are worth it.
 */

/** Keys worth surviving a WebView storage clear. */
const DURABLE_KEYS = [
  // The phone cannot reach the computer without this.
  "orbit.remote.pairing.v1",
  // Whether mobile access should come back after a restart.
  "orbit.remote.hostEnabled",
  "orbit.remote.transport",
  // Preferences the user set deliberately, in the screen channel and the shell.
  "orbit.screen.prefs.v1",
  "orbit.screen.prefs.v2",
  "orbit.screen.pip.v1",
  // Which project was open. Losing it drops the user back to the picker while
  // the pairing — which is mirrored — survives, which is an odd half-state.
  "pi-gui.cwd",
  "pi-gui.workspaceMode",
  // Where a launch lands, and whether Orbit holds the machine awake while it
  // runs. Both are deliberate preferences; losing them changes the daily
  // behaviour of the app rather than costing one click.
  "orbit.startup.panel",
  "orbit.keepAwake",
  "pi-gui.sidebarOpen",
  "pi-gui.sidebarOpen.narrow",
  // Whether the phone should hold its pairing connection while the app is in
  // the background. A phone that lost this would silently stop being reachable
  // between two launches, which is the same class as losing the pairing itself.
  "orbit.background.connection",
] as const

const STORE_FILE = "orbit-state.json"

let store: LazyStore | null = null

function durableStore(): LazyStore | null {
  if (store) return store
  try {
    store = new LazyStore(STORE_FILE)
  } catch {
    // Browser preview (`bun run dev`) has no Tauri backend. The mirror is a
    // durability improvement, not a requirement, so its absence is silent.
    store = null
  }
  return store
}

/** Whether this runtime has a durable backend at all. */
export function hasDurableStorage(): boolean {
  return durableStore() !== null
}

/**
 * Restore durable values into `localStorage`.
 *
 * Awaited once during bootstrap, before anything reads these keys. A key that is
 * already present locally wins: it is the more recent of the two only if the
 * durable write failed, and either way not overwriting it keeps this function
 * from ever losing data.
 */
export async function restorePersistentState(): Promise<void> {
  const target = durableStore()
  if (!target) return
  try {
    for (const key of DURABLE_KEYS) {
      const value = await target.get<string>(key)
      if (value === undefined || value === null) continue
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value)
    }
  } catch {
    // A corrupt or unreadable store must not block startup; the app runs on
    // localStorage exactly as it did before this module existed.
  }
}

/**
 * Record a value durably.
 *
 * Called after the `localStorage` write so the synchronous path never waits on
 * it. Failures are ignored for the same reason `restorePersistentState` is
 * forgiving: durability is a safety net, not a dependency.
 */
export function persistState(key: string, value: string | null): void {
  if (!(DURABLE_KEYS as readonly string[]).includes(key)) return
  const target = durableStore()
  if (!target) return
  void (value === null ? target.delete(key) : target.set(key, value)).catch(() => undefined)
}
