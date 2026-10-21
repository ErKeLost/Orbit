import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { installMemoryLocalStorage } from "./support/local-storage"

/**
 * Launch defaults: the panel a cold start opens on, and the assertion that
 * keeps the machine awake while Orbit runs.
 *
 * Both are read while React builds its first state, so both are synchronous
 * `localStorage` values — which is exactly why they need a test: a missing or
 * misspelled key degrades silently to "the app forgot", and the mirror list in
 * `persistent.ts` is what decides whether clearing the WebView storage repairs
 * the choice or quietly reverts it.
 */

// The shared in-memory store, not `??=`: another suite may have installed a
// no-op mock before this file runs (see `tests/support/local-storage.ts`).
const memory = installMemoryLocalStorage()

const { readStartupPanel, writeStartupPanel, STARTUP_PANEL_DEFAULT, STARTUP_PANEL_KEY, STARTUP_PANELS } = await import("../src/lib/startup-panel")
const { KEEP_AWAKE_KEY, readKeepAwake, writeKeepAwake } = await import("../src/lib/desktop-integration")

function reset() {
  memory.entries.clear()
}

describe("startup panel", () => {
  test("opens on 「会话」 by default", () => {
    reset()
    expect(STARTUP_PANEL_DEFAULT).toBe("chat")
    expect(readStartupPanel()).toBe("chat")
    // The pairing page is still a landing surface the user can pick: a phone that
    // connects over the relay rather than on the same Wi-Fi has to reach it.
    expect(STARTUP_PANELS.map(panel => panel.label)).toContain("移动端")
  })

  test("remembers the page the user picked", () => {
    reset()
    writeStartupPanel("inbox")
    expect(readStartupPanel()).toBe("inbox")
    expect(memory.entries.get(STARTUP_PANEL_KEY)).toBe("inbox")
  })

  test("falls back when the stored value is not a landing surface", () => {
    reset()
    // `settings` is a real panel, but not one a launch should open on.
    memory.setItem(STARTUP_PANEL_KEY, "settings")
    expect(readStartupPanel()).toBe(STARTUP_PANEL_DEFAULT)
  })
})

describe("keep awake", () => {
  test("defaults to on", () => {
    reset()
    expect(readKeepAwake()).toBe(true)
    // Only the explicit off is stored, so the default survives a new key.
    expect(memory.entries.size).toBe(0)
  })

  test("stores the choice and reports what the runtime holds", async () => {
    reset()
    // Tests run without a Tauri backend, where the request is simply echoed.
    expect(await writeKeepAwake(false)).toBe(false)
    expect(readKeepAwake()).toBe(false)
    expect(memory.entries.get(KEEP_AWAKE_KEY)).toBe("false")
  })
})

describe("durability", () => {
  test("both launch defaults are mirrored into the durable store", () => {
    // The regression this guards: a key that is read at startup but missing
    // from `DURABLE_KEYS` still works — until the WebView storage is cleared,
    // at which point the user's choice disappears without a trace.
    const persistent = readFileSync("src/lib/persistent.ts", "utf8")
    expect(persistent).toContain(`"${STARTUP_PANEL_KEY}"`)
    expect(persistent).toContain(`"${KEEP_AWAKE_KEY}"`)
  })
})
