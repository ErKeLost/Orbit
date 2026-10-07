/**
 * Guards for the defects that reached a phone because nothing mechanical looked
 * for them.
 *
 * Each test here corresponds to something that was found by testing by hand on a
 * device — which is the most expensive way to find a defect, and the slowest.
 * The rule these encode: if a mistake is detectable by reading the source, a
 * test should detect it, not a person.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

function filesUnder(root: string, extension: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) found.push(...filesUnder(path, extension))
    else if (path.endsWith(extension)) found.push(path)
  }
  return found
}

const COMPONENTS = filesUnder("src", ".tsx")
const SOURCES = [...filesUnder("src", ".ts"), ...COMPONENTS]

describe("icon imports", () => {
  test("deep imports match the catalog filename case on every platform", () => {
    // macOS and Windows can resolve misspelled case that fails on Linux.
    const catalog = new Set(readdirSync("node_modules/@hugeicons/core-free-icons/dist/types"))
    const invalid: string[] = []
    for (const file of SOURCES) {
      for (const match of readFileSync(file, "utf8").matchAll(/from ["']@hugeicons\/core-free-icons\/([^"']+)["']/g)) {
        if (!catalog.has(`${match[1]}.d.ts`)) invalid.push(`${file}: ${match[1]}`)
      }
    }
    expect(invalid).toEqual([])
  })
})

describe("durable state", () => {
  test("every key written to localStorage is either mirrored or explicitly excluded", () => {
    // `localStorage` lives in the WebView's storage area, which the system can
    // clear. A handful of keys are mirrored into `plugin-store` so that clearing
    // it is repaired rather than noticed. The mirror is driven by a list, and a
    // list that drifts means a key silently stops being durable — the exact
    // shape of the bug that made a pairing URI disappear.
    const persistent = readFileSync("src/lib/persistent.ts", "utf8")
    const durable = new Set([...persistent.matchAll(/^\s*"([^"]+)",$/gm)].map(match => match[1]!))
    expect(durable.size).toBeGreaterThan(5)

    // Keys that are cheap to lose, with the reason.
    const excluded: Record<string, string> = {
      "pi-gui.perfLog": "diagnostics buffer, regenerated every run",
      "pi-gui.perfTier": "manual override read by perf-tier.ts, never written by the app",
      "orbit.remote.connection.v1": "recovered from the host snapshot on connect",
      "pi-gui.multiAgentEnabled": "a switch whose default is fine",
      "pi-gui.computerUseEnabled": "a switch whose default is fine",
      "pi-gui.sidebarOpen": "cosmetic; note the narrow variant below IS durable",
      "orbit.terminal.position": "cosmetic dock placement, defaults to bottom",
      "orbit.terminal.open": "cosmetic visibility, defaults to closed",
      "orbit.shell.collapsedRail": "cosmetic rail style, defaults to compact",
    }

    const written = new Set<string>()
    for (const file of SOURCES) {
      for (const match of readFileSync(file, "utf8").matchAll(/localStorage\.(?:setItem|getItem|removeItem)\("([^"]+)"/g)) {
        written.add(match[1]!)
      }
    }
    const unaccounted = [...written].filter(key => !durable.has(key) && !(key in excluded))
    expect({ unaccounted }).toEqual({ unaccounted: [] })
  })
})

describe("stylesheet loading", () => {
  test("a stylesheet needed by an always-rendered component is not only imported by a lazy one", () => {
    // The floating screen window rendered with no stylesheet at all because its
    // CSS was imported only by the lazily loaded settings panel: until that page
    // was opened, the CSS was not in the bundle. The window laid itself out as a
    // plain block and pushed the page open.
    //
    // The invariant: `App` renders `ScreenOverlay` unconditionally, so whatever
    // that overlay needs must be reachable without a lazy import.
    const overlay = readFileSync("src/components/screen/ScreenOverlay.tsx", "utf8")
    expect(overlay).toContain('import "../../styles/screen-channel.css"')

    // ...and the stylesheet must actually carry the positioning rules, since
    // without `position: fixed` the window participates in layout.
    const css = readFileSync("src/styles/screen-channel.css", "utf8")
    const rule = css.slice(css.indexOf(".screen-pip {"), css.indexOf("}", css.indexOf(".screen-pip {")))
    expect(rule).toContain("position: fixed")
  })
})

describe("async transport", () => {
  test("the connection loops do not poll", () => {
    // The transport was rewritten so a socket can be read and written at the
    // same time. A polling interval would silently reintroduce the latency tax
    // the rewrite removed, and it is invisible in a diff.
    const remote = readFileSync("src-tauri/src/remote.rs", "utf8")
    expect(remote).not.toContain("SOCKET_POLL_INTERVAL")
    expect(remote).not.toContain("set_read_timeout")
    // Frames are delivered by a wake signal rather than by a tick: the bus
    // signals each subscriber's channel, and the relay's shared loop has a
    // notification for outbound work of any kind.
    const screen = readFileSync("src-tauri/src/screen/mod.rs", "utf8")
    expect(screen).toMatch(/wake\.try_send/)
    expect(remote).toMatch(/clients\.work\.notified\(\)/)
  })
})
