import { beforeEach, describe, expect, test, vi } from "vitest"

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("./native", () => ({ invoke: native.invoke }))
const { importBrowserSession } = await import("./browser-import")
const report = {browser:"Google Chrome",profile:"Default",cookies:100,deviceBound:false,importedAt:100,partition:"test",version:3}

describe("browser profile import lifecycle", () => {
  beforeEach(() => native.invoke.mockReset())
  test("two panels cannot import different profiles at the same time", async () => {
    let complete!: (value: unknown) => void
    native.invoke.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const first = importBrowserSession("Google Chrome", "Default")
    await expect(importBrowserSession("Google Chrome", "Profile 1")).rejects.toThrow("已有浏览器导入")
    expect(native.invoke).toHaveBeenCalledOnce()
    complete(report)
    await expect(first).resolves.toMatchObject({report})
  })
  test("failure resumes native placement and permits a retry", async () => {
    const resumed = vi.fn()
    window.addEventListener("orbit:browser-profile-changed", resumed)
    native.invoke.mockRejectedValueOnce(new Error("key unavailable"))
    await expect(importBrowserSession("Google Chrome", "Default")).rejects.toThrow("key unavailable")
    expect(resumed).toHaveBeenCalledOnce()
    native.invoke.mockResolvedValueOnce(report)
    await expect(importBrowserSession("Google Chrome", "Default")).resolves.toMatchObject({cookies:100})
    window.removeEventListener("orbit:browser-profile-changed", resumed)
  })
})
