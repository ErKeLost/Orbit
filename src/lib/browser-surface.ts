import { syncBrowserView, type BrowserViewStatus, type ViewRect } from "./browser-view"

const owners = new Map<string, symbol>()
const pending = new Map<string, Promise<unknown>>()

/** Serialize native placement and fence a surface's late hide when PiP takes over. */
export function claimBrowserSurface(tab: string) {
  const owner = Symbol(tab)
  owners.set(tab, owner)
  let box: ViewRect | undefined
  let revision = 0
  const enqueue = (action: () => Promise<BrowserViewStatus | undefined>) => {
    const result = (pending.get(tab) ?? Promise.resolve()).catch(() => undefined).then(action)
    pending.set(tab, result)
    void result.finally(() => { if (pending.get(tab) === result) pending.delete(tab) }).catch(() => undefined)
    return result
  }
  return {
    present(rect: ViewRect, url?: string, visible = true, background = false) {
      box = rect
      const current = ++revision
      return enqueue(() => owners.get(tab) === owner && current === revision ? syncBrowserView(tab, rect, url, visible, background) : Promise.resolve(undefined))
    },
    release() {
      if (owners.get(tab) !== owner) return
      owners.delete(tab)
      const last = box
      if (last) void enqueue(() => !owners.has(tab) ? syncBrowserView(tab, last, undefined, false) : Promise.resolve(undefined)).catch(() => undefined)
    },
  }
}
