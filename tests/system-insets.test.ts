import { describe, expect, test } from "bun:test"
import {
  INSETS_GLOBAL,
  SYSTEM_INSET_BOTTOM_VAR,
  SYSTEM_INSET_TOP_VAR,
  applySystemBarInsets,
  observeSystemBarInsets,
  parseSystemBarInsets,
  type SystemInsetHost,
} from "../src/lib/system-insets"

/**
 * The Android system bars.
 *
 * The phone's title bar drew under the status bar and could not be touched,
 * because `env(safe-area-inset-top)` is the display *cutout* in a WebView rather
 * than the status bar — 0 on any phone without a notch. The native half of the
 * fix cannot be unit tested here, so the parsing and the two paths that carry
 * the numbers (push on change, pull on mount) are pinned exactly. The rule that
 * matters: a bad answer must never move the title bar somewhere the user cannot
 * press, so anything unparseable is ignored and `env()` stays as the floor.
 */
function fakeStyle() {
  const values = new Map<string, string>()
  return {
    values,
    getPropertyValue: (name: string) => values.get(name) ?? "",
    setProperty: (name: string, value: string) => {
      values.set(name, value)
    },
  }
}

function fakeWindow() {
  const handlers = new Map<string, Set<() => void>>()
  const host: SystemInsetHost = {
    addEventListener(type: string, listener: () => void) {
      const set = handlers.get(type) ?? new Set<() => void>()
      set.add(listener)
      handlers.set(type, set)
    },
    removeEventListener(type: string, listener: () => void) {
      handlers.get(type)?.delete(listener)
    },
  }
  return {
    host,
    emit(type: string) {
      for (const listener of [...(handlers.get(type) ?? [])]) listener()
    },
    count: (type: string) => handlers.get(type)?.size ?? 0,
  }
}

describe("parseSystemBarInsets", () => {
  test("reads the native answer as CSS pixels", () => {
    expect(parseSystemBarInsets("28,48")).toEqual({ top: 28, bottom: 48 })
    expect(parseSystemBarInsets(" 0 , 0 ")).toEqual({ top: 0, bottom: 0 })
    expect(parseSystemBarInsets("24.6,0")).toEqual({ top: 25, bottom: 0 })
  })

  test("a negative inset is clamped, since it can only mean a bad answer", () => {
    expect(parseSystemBarInsets("-4,0")).toEqual({ top: 0, bottom: 0 })
  })

  test("anything unparseable is no answer at all, not a zero", () => {
    expect(parseSystemBarInsets(null)).toBeNull()
    expect(parseSystemBarInsets(undefined)).toBeNull()
    expect(parseSystemBarInsets("")).toBeNull()
    expect(parseSystemBarInsets("28")).toBeNull()
    expect(parseSystemBarInsets("28,48,12")).toBeNull()
    expect(parseSystemBarInsets("top,48")).toBeNull()
    expect(parseSystemBarInsets("NaN,48")).toBeNull()
    expect(parseSystemBarInsets("Infinity,48")).toBeNull()
  })
})

describe("applySystemBarInsets", () => {
  test("writes both bars, and rewrites only when the number moves", () => {
    const style = fakeStyle()
    applySystemBarInsets({ top: 28, bottom: 48 }, style)
    expect(style.values.get(SYSTEM_INSET_TOP_VAR)).toBe("28px")
    expect(style.values.get(SYSTEM_INSET_BOTTOM_VAR)).toBe("48px")

    const before = style.values.get(SYSTEM_INSET_TOP_VAR)
    applySystemBarInsets({ top: 28, bottom: 48 }, style)
    expect(style.values.get(SYSTEM_INSET_TOP_VAR)).toBe(before)
  })
})

describe("observeSystemBarInsets", () => {
  test("pulls on mount, because the native push can land before the script runs", () => {
    const style = fakeStyle()
    const { host, count } = fakeWindow()
    const stop = observeSystemBarInsets({ style, host, native: { insets: () => "28,48" }, events: null })
    expect(style.values.get(SYSTEM_INSET_TOP_VAR)).toBe("28px")
    expect(style.values.get(SYSTEM_INSET_BOTTOM_VAR)).toBe("48px")
    stop()
    expect(count("resize")).toBe(0)
  })

  test("the push bridge is installed before the pull runs", () => {
    const style = fakeStyle()
    const { host } = fakeWindow()
    let installedDuringPull = false
    const stop = observeSystemBarInsets({
      style,
      host,
      native: {
        insets: () => {
          // The native side calls the push as soon as it has news; if the mount
          // pull ran first, that news would land on nothing.
          installedDuringPull = typeof host[INSETS_GLOBAL] === "function"
          return "28,48"
        },
      },
      events: null,
    })
    expect(installedDuringPull).toBe(true)
    stop()
    expect(host[INSETS_GLOBAL]).toBeUndefined()
  })

  test("a push moves the bars; a bad push leaves them alone", () => {
    const style = fakeStyle()
    const { host } = fakeWindow()
    const stop = observeSystemBarInsets({ style, host, native: { insets: () => "0,0" }, events: null })
    const push = host[INSETS_GLOBAL] as (top: unknown, bottom: unknown) => void
    push(24, 48)
    expect(style.values.get(SYSTEM_INSET_TOP_VAR)).toBe("24px")
    expect(style.values.get(SYSTEM_INSET_BOTTOM_VAR)).toBe("48px")
    push("nope", 48)
    expect(style.values.get(SYSTEM_INSET_TOP_VAR)).toBe("24px")
    stop()
  })

  test("re-pulls on rotation, and leaves the variables untouched when there is no answer", () => {
    const style = fakeStyle()
    const { host, emit, count } = fakeWindow()
    let answer: string | null = null
    const stop = observeSystemBarInsets({ style, host, native: { insets: () => answer as string }, events: host as unknown as EventTarget })
    expect(style.values.get(SYSTEM_INSET_TOP_VAR)).toBeUndefined()
    answer = "24,0"
    emit("resize")
    expect(style.values.get(SYSTEM_INSET_TOP_VAR)).toBe("24px")
    answer = "40,0"
    emit("orientationchange")
    expect(style.values.get(SYSTEM_INSET_TOP_VAR)).toBe("40px")
    expect(count("resize")).toBe(1)

    stop()
    expect(count("resize")).toBe(0)
    expect(count("orientationchange")).toBe(0)
  })

  test("unregistering removes its own push and no one else's", () => {
    const style = fakeStyle()
    const { host } = fakeWindow()
    const stop = observeSystemBarInsets({ style, host, native: null, events: null })
    const replacement = () => undefined
    host[INSETS_GLOBAL] = replacement
    stop()
    expect(host[INSETS_GLOBAL]).toBe(replacement)
  })

  test("a throwing bridge is the same as a missing one", () => {
    const style = fakeStyle()
    const { host } = fakeWindow()
    const stop = observeSystemBarInsets({
      style,
      host,
      native: {
        insets: () => {
          throw new Error("bridge died")
        },
      },
      events: null,
    })
    expect(style.values.get(SYSTEM_INSET_TOP_VAR)).toBeUndefined()
    stop()
  })
})
