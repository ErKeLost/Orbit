import { describe, expect, test, vi } from "vitest"
const sync = vi.hoisted(() => vi.fn(async () => ({ open:true, url:"", visible:true, loading:false })))
vi.mock("./browser-view", () => ({ syncBrowserView: sync }))
const { claimBrowserSurface } = await import("./browser-surface")
const rect = { x:10, y:20, width:400, height:300 }
describe("browser surface ownership", () => {
  test("a dock's pending hide cannot hide the page after PiP claims it", async () => {
    const dock=claimBrowserSurface("page")
    await dock.present(rect)
    dock.release()
    const pip=claimBrowserSurface("page")
    await pip.present({...rect,x:100})
    expect(sync.mock.calls).toHaveLength(2)
    expect(sync.mock.calls.at(-1)).toEqual(["page",{...rect,x:100},undefined,true,false])
    dock.release()
    await pip.present({...rect,x:120})
    expect(sync.mock.calls.at(-1)?.[3]).toBe(true)
    pip.release()
  })
})
