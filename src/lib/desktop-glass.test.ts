import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }))

const { setDesktopGlassEnabled, desktopSampleState } = await import("./desktop-glass")

/**
 * The layer is the whole feature: it carries the theme colour so a missing
 * sample still looks like the window it replaces, and it is the only thing the
 * glass toggle actually adds or removes from the page.
 */
function layerCount() {
  return document.querySelectorAll(".desktop-glass-layer").length
}

describe("desktop glass layer", () => {
  beforeEach(() => {
    // Capture work is scheduled on a timer; keeping timers frozen keeps this a
    // test of the layer contract instead of of the IPC round trip.
    vi.useFakeTimers()
    bridge.invoke.mockReset()
    document.documentElement.className = ""
    document.body.innerHTML = ""
    setDesktopGlassEnabled(false)
  })

  afterEach(() => {
    setDesktopGlassEnabled(false)
    vi.useRealTimers()
  })

  test("the toggle owns exactly one layer", () => {
    setDesktopGlassEnabled(true)
    setDesktopGlassEnabled(true)
    expect(layerCount()).toBe(1)

    setDesktopGlassEnabled(false)
    expect(layerCount()).toBe(0)
  })

  test("the layer paints the theme colour before any sample arrives", () => {
    setDesktopGlassEnabled(true)
    const layer = document.querySelector<HTMLElement>(".desktop-glass-layer")
    expect(layer?.className).toContain("desktop-glass-layer")
    // No inline background-image yet: the base colour comes from CSS, so the
    // window never flashes Chromium's white while the first capture is in flight.
    expect(layer?.style.backgroundImage).toBe("")
    expect(document.documentElement.classList.contains("has-desktop-sample")).toBe(false)
    expect(desktopSampleState().ready).toBe(false)
  })

  test("the layer sits under the page, not over it", () => {
    setDesktopGlassEnabled(true)
    const layer = document.querySelector<HTMLElement>(".desktop-glass-layer")
    expect(layer?.getAttribute("aria-hidden")).toBe("true")
    // `prepend` keeps it the first node; the z-index in the stylesheet does the rest.
    expect(document.body.firstElementChild).toBe(layer)
  })
})
