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
      "pi-gui.browserUseEnabled": "a switch whose default is fine",
      "pi-gui.sidebarOpen": "cosmetic; note the narrow variant below IS durable",
      "orbit.terminal.position": "cosmetic dock placement, defaults to bottom",
      "orbit.terminal.open": "cosmetic visibility, defaults to closed",
      "orbit.browser.open": "cosmetic visibility, defaults to closed",
      "orbit.browser.size": "cosmetic browser column width, defaults to 520",
      "orbit.shell.collapsedRail": "cosmetic rail style, defaults to compact",
      "orbit.shell.railSessions": "cosmetic: whether the rail's session list is expanded, defaults to open",
      "orbit.quickScope": "跨窗口的一行提示：quick composer 显示主窗口在哪个目录，丢了就显示「没有项目」",
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

describe("window drag regions", () => {
  test("chrome headers use the subtree form, never a bare drag region", () => {
    // Tauri 2.11's injected drag script treats a bare `data-tauri-drag-region`
    // as "this element only": the walk returns false unless the attribute owner
    // is the click target itself, and any clickable child blocks the drag. Every
    // app header is filled edge to edge by non-clickable wrappers, so a bare
    // attribute leaves zero draggable pixels and the window cannot be moved at
    // all. `"deep"` starts a drag from anywhere in the subtree except on
    // clickable elements, which is what a title bar has to do.
    const bare: string[] = []
    for (const file of COMPONENTS) {
      const source = readFileSync(file, "utf8")
      for (const match of source.matchAll(/data-tauri-drag-region(?![\w-])(?!\s*=\s*["'])/g)) {
        const line = source.slice(0, match.index).split("\n").length
        bare.push(`${file}:${line}`)
      }
    }
    expect(bare).toEqual([])
  })
})

describe("terminal dock ownership", () => {
  test("the dock hangs off the workspace, not a session pane", () => {
    // The dock used to render inside `ChatPane`, so closing the chat pane — or
    // switching to a split whose session pane was not the one holding it —
    // unmounted the xterm and killed the shell the user was watching. A dock is
    // a property of the workspace: it has to sit beside the pane grid, and only
    // the phone shell (one surface, no grid) mounts it from `ChatPane`.
    const app = readFileSync("src/App.tsx", "utf8")
    expect(app).toContain("<TerminalDock")
    const workArea = app.slice(app.indexOf("function WorkArea("), app.indexOf("export default function App("))
    expect(workArea).toContain("<TerminalDock")

    const chatPane = readFileSync("src/features/chat/ChatPane.tsx", "utf8")
    // Off by default, and the render is gated on it rather than on `true`.
    expect(chatPane).toMatch(/withTerminal = false/)
    expect(chatPane).toMatch(/terminalAvailable = withTerminal/)
    expect(readFileSync("src/features/shell/rail/MobileShell.tsx", "utf8")).toContain("<ChatPane withTerminal />")
  })

  test("hiding the dock keeps its shells", () => {
    // `hidden` is not `unmounted`: collapsing the panel must not end PTYs, and
    // it also used to throw away the tab list, so ⌘J twice left a fresh shell.
    const dock = readFileSync("src/features/terminal/TerminalDock.tsx", "utf8")
    expect(dock).toContain("hidden={!open}")
    expect(dock).toContain('invoke("pty_kill"')
  })
})

describe("panel switches keep the work area alive", () => {
  test("full-page surfaces are drawn beside the chat surface, not instead of it", () => {
    // The chat surface (title bar, terminal dock, pane grid) used to be replaced
    // by settings/inbox/search/automations through an early return, which
    // unmounted the grid: the browser page lost its native view, editors lost
    // scroll and drafts, and the terminal dock had to be rebuilt from scratch.
    // Now the grid is hidden, never unmounted.
    const app = readFileSync("src/App.tsx", "utf8")
    const workArea = app.slice(app.indexOf("function WorkArea("), app.indexOf("export default function App("))
    expect(workArea).not.toMatch(/if \(panel === "(settings|inbox|search|automations)"\) return/)
    expect(workArea).toContain('{panel === "settings" ? <SettingsView /> : null}')
    // The grid itself is conditional CSS, not a conditional render.
    expect(workArea).toMatch(/className=\{panel === "chat" \? "relative min-h-0 min-w-0 flex-1" : "hidden"\}/)
  })

  test("a zero-sized browser stage hides the native view instead of leaving it floating", () => {
    // The OS view is a sibling of the document, not part of layout: when the grid
    // is hidden nobody reports a rectangle, and an un-hidden view stays drawn on
    // top of whatever replaced it. Hiding (not closing) keeps the page alive.
    const tab = readFileSync("src/features/browser/BrowserTab.tsx", "utf8")
    expect(tab).toContain('last = "hidden"')
    expect(tab).toContain("void syncBrowserView(path, parked, undefined, false)")
  })
})

describe("browser column ownership", () => {
  test("browser tabs are the window's, not a workspace's", () => {
    // A page that a link opened used to be a file tab in a pane, so closing the
    // pane, splitting it away or switching workspace tabs destroyed the native
    // view. It is a column of the window now: the tab entry lives in the shell,
    // and the dock sits beside `WorkArea`, outside every workspace and panel.
    const model = readFileSync("src/features/shell/shellModel.ts", "utf8")
    expect(model).not.toMatch(/browser\?: \{ url/)
    expect(model).toContain("export type BrowserTabInfo")

    const app = readFileSync("src/App.tsx", "utf8")
    expect(app).toContain("<BrowserDock />")
    expect(app.indexOf("<BrowserDock />")).toBeGreaterThan(app.indexOf("<WorkArea withSessions"))

    const dock = readFileSync("src/features/browser/BrowserDock.tsx", "utf8")
    // Collapsing keeps the pages: hiding is not unmounting.
    expect(dock).toContain("hidden={!open}")
    expect(dock).toContain("hidden={tab.path !== shown?.path}")
  })
})
