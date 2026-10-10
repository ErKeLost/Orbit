import { describe, expect, test } from "bun:test"
import {
  KEYBOARD_INSET_VAR,
  MIN_KEYBOARD_INSET,
  applyKeyboardInset,
  keyboardInset,
  observeKeyboardInset,
  type InsetTarget,
  type ViewportMetrics,
} from "../src/lib/keyboard-inset"

/**
 * The keyboard inset.
 *
 * The phone's composer was hidden by the keyboard because an Android WebView is
 * never resized for the IME. The native half of the fix cannot be unit tested
 * here, so the arithmetic and the subscription that the web half depends on are
 * pinned exactly — especially the two rules that keep it from fighting the
 * native padding: a shell that *was* resized reports zero, and a delta under the
 * threshold is browser chrome rather than a keyboard.
 */
const metrics = (over: Partial<ViewportMetrics> = {}): ViewportMetrics => ({
  innerHeight: 900,
  viewportHeight: 900,
  viewportOffsetTop: 0,
  ...over,
})

function fakeStyle() {
  const values = new Map<string, string>()
  let writes = 0
  return {
    values,
    writes: () => writes,
    getPropertyValue: (name: string) => values.get(name) ?? "",
    setProperty: (name: string, value: string) => {
      writes += 1
      values.set(name, value)
    },
  }
}

function fakeTarget() {
  const handlers = new Map<string, Set<EventListenerOrEventListenerObject>>()
  return {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const set = handlers.get(type) ?? new Set<EventListenerOrEventListenerObject>()
      set.add(listener)
      handlers.set(type, set)
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      handlers.get(type)?.delete(listener)
    },
    emit(type: string) {
      for (const listener of [...(handlers.get(type) ?? [])]) {
        if (typeof listener === "function") listener({ type } as Event)
      }
    },
    count(type: string) {
      return handlers.get(type)?.size ?? 0
    },
  } satisfies InsetTarget & { emit(type: string): void; count(type: string): number }
}

describe("keyboard inset", () => {
  test("is zero while nothing shrank", () => {
    expect(keyboardInset(metrics())).toBe(0)
  })

  test("is the covered height once the keyboard takes it", () => {
    expect(keyboardInset(metrics({ viewportHeight: 580 }))).toBe(320)
  })

  test("ignores a delta too small to be a keyboard", () => {
    expect(keyboardInset(metrics({ viewportHeight: 900 - (MIN_KEYBOARD_INSET - 1) }))).toBe(0)
    expect(keyboardInset(metrics({ viewportHeight: 900 - MIN_KEYBOARD_INSET }))).toBe(MIN_KEYBOARD_INSET)
  })

  test("counts the part a panned page hides", () => {
    // The visual viewport moved down by 200: only 100 of it is still covered.
    expect(keyboardInset(metrics({ viewportHeight: 600, viewportOffsetTop: 200 }))).toBe(100)
    // Panned past the keyboard: nothing is covered, and never negative.
    expect(keyboardInset(metrics({ viewportHeight: 600, viewportOffsetTop: 400 }))).toBe(0)
  })

  test("reports zero for the metrics a detached viewport gives", () => {
    expect(keyboardInset(metrics({ innerHeight: Number.NaN }))).toBe(0)
    expect(keyboardInset(metrics({ viewportHeight: Number.POSITIVE_INFINITY }))).toBe(0)
    expect(keyboardInset(metrics({ viewportOffsetTop: Number.NaN }))).toBe(0)
  })

  test("rounds to whole pixels", () => {
    expect(keyboardInset(metrics({ viewportHeight: 579.4 }))).toBe(321)
  })
})

describe("publishing the inset", () => {
  test("writes pixels, and zero as zero rather than removing the property", () => {
    const style = fakeStyle()
    applyKeyboardInset(0, style)
    expect(style.values.get(KEYBOARD_INSET_VAR)).toBe("0px")
    applyKeyboardInset(288, style)
    expect(style.values.get(KEYBOARD_INSET_VAR)).toBe("288px")
  })

  test("does not rewrite an unchanged value", () => {
    const style = fakeStyle()
    applyKeyboardInset(288, style)
    applyKeyboardInset(288, style)
    expect(style.writes()).toBe(1)
  })
})

describe("observing the keyboard", () => {
  test("follows every event that can carry the keyboard, then lets go", () => {
    const style = fakeStyle()
    const viewport = fakeTarget()
    const host = fakeTarget()
    let current = metrics()
    const stop = observeKeyboardInset({ style, viewport, window: host, metrics: () => current })

    // Published once on mount, so a shell mounting with the keyboard up is right.
    expect(style.values.get(KEYBOARD_INSET_VAR)).toBe("0px")
    expect(viewport.count("resize")).toBe(1)
    expect(viewport.count("scroll")).toBe(1)
    expect(host.count("resize")).toBe(1)

    current = metrics({ viewportHeight: 900 - 300 })
    viewport.emit("resize")
    expect(style.values.get(KEYBOARD_INSET_VAR)).toBe("300px")

    // A panned page is a `scroll`, not a resize, and must recompute too.
    current = metrics({ viewportHeight: 600, viewportOffsetTop: 400 })
    viewport.emit("scroll")
    expect(style.values.get(KEYBOARD_INSET_VAR)).toBe("0px")

    stop()
    expect(viewport.count("resize")).toBe(0)
    expect(viewport.count("scroll")).toBe(0)
    expect(host.count("resize")).toBe(0)
    // Unmounting clears it: a stale inset would outlive the shell that set it.
    expect(style.values.get(KEYBOARD_INSET_VAR)).toBe("0px")
  })

  test("survives a shell with no visual viewport at all", () => {
    const style = fakeStyle()
    const host = fakeTarget()
    let current = metrics({ viewportHeight: 500 })
    const stop = observeKeyboardInset({ style, viewport: null, window: host, metrics: () => current })
    expect(style.values.get(KEYBOARD_INSET_VAR)).toBe("400px")
    stop()
    expect(style.values.get(KEYBOARD_INSET_VAR)).toBe("0px")
  })

  test("is inert where there is no window to observe", () => {
    // Calls the real defaults on purpose: tests and any server render must not
    // need a DOM to import or mount this.
    expect(() => observeKeyboardInset()()).not.toThrow()
  })
})
