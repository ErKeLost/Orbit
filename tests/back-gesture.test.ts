import { describe, expect, test } from "bun:test"
import {
  BACK_GLOBAL,
  backHandlerCount,
  handleBackPress,
  installBackGesture,
  registerBackHandler,
} from "../src/lib/back-gesture"

/**
 * The Android back gesture.
 *
 * Before this existed, back left the app from anywhere: nothing pushes history,
 * so `WryActivity`'s `canGoBack()` was always false. What has to stay true is
 * that the press reaches the surface the user is looking at, that a surface can
 * decline without swallowing it, and that nothing a surface does — including
 * throwing — can make back do nothing at all.
 */
describe("routing a back press", () => {
  test("nothing registered means nothing claimed it", () => {
    expect(handleBackPress()).toBe(false)
  })

  test("the newest surface is asked first, and only one acts", () => {
    const asked: string[] = []
    const offDrawer = registerBackHandler(() => (asked.push("drawer"), true))
    const offFile = registerBackHandler(() => (asked.push("file"), true))
    expect(handleBackPress()).toBe(true)
    expect(asked).toEqual(["file"])
    offFile()
    expect(handleBackPress()).toBe(true)
    expect(asked).toEqual(["file", "drawer"])
    offDrawer()
  })

  test("a surface that has moved on declines instead of swallowing the press", () => {
    const offFile = registerBackHandler(() => false)
    const offDrawer = registerBackHandler(() => true)
    // The file pane is registered under the drawer but nothing is open in it.
    expect(handleBackPress()).toBe(true)
    offDrawer()
    // Now nothing wants it: this is what lets the app exit.
    expect(handleBackPress()).toBe(false)
    offFile()
  })

  test("a broken surface cannot make back unusable", () => {
    const offBroken = registerBackHandler(() => {
      throw new Error("overlay is mid-teardown")
    })
    expect(handleBackPress()).toBe(false)
    const offDrawer = registerBackHandler(() => true)
    expect(handleBackPress()).toBe(true)
    offDrawer()
    offBroken()
  })

  test("unregistering is by identity, so an out-of-order close is safe", () => {
    const first = registerBackHandler(() => true)
    const second = registerBackHandler(() => true)
    const third = registerBackHandler(() => true)
    expect(backHandlerCount()).toBe(3)
    second()
    expect(backHandlerCount()).toBe(2)
    first()
    third()
    expect(backHandlerCount()).toBe(0)
    // A double release must not remove somebody else's claim.
    third()
    expect(backHandlerCount()).toBe(0)
  })
})

describe("publishing the gesture to native code", () => {
  test("installs a global the native side can call", () => {
    const target: Record<string, unknown> = {}
    const uninstall = installBackGesture(target)
    expect(typeof target[BACK_GLOBAL]).toBe("function")
    expect((target[BACK_GLOBAL] as () => boolean)()).toBe(false)
    const off = registerBackHandler(() => true)
    expect((target[BACK_GLOBAL] as () => boolean)()).toBe(true)
    off()
    uninstall()
    expect(BACK_GLOBAL in target).toBe(false)
  })

  test("a late unmount does not delete a newer install", () => {
    const target: Record<string, unknown> = {}
    const first = installBackGesture(target)
    const second = installBackGesture(target)
    first()
    expect(typeof target[BACK_GLOBAL]).toBe("function")
    second()
    expect(BACK_GLOBAL in target).toBe(false)
  })
})
