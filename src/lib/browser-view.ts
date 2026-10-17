/**
 * The column's engine view: a real child web view in the window.
 *
 * This is not a frame stream. The OS draws the page directly where the column
 * says it is (`browser_view.rs`), so text is crisp at any scale, scrolling and
 * selection are native, and no pixels are ever encoded. What the panel shows is
 * the browser, not a picture of one.
 *
 * The page in it has no access to Orbit at all: the view is in no capability, so
 * the only channel is the one below — from the app into the page.
 */

import { invoke } from "./native"

export type ViewRect = { x: number; y: number; width: number; height: number }
export type BrowserViewStatus = { open: boolean; url: string; visible: boolean; loading: boolean }

/**
 * One view per browser tab; `tab` is the tab entry's path (`browser:<id>`).
 *
 * This is the tab's whole surface except for back/forward/reload/stop: `sync`
 * creates the view at the tab's rectangle, loads the address it is given, and
 * shows or hides it — one call, so there is no window between "the tab exists"
 * and "the page is loading" for a race to fall into.
 */
export function syncBrowserView(tab: string, rect: ViewRect, url?: string, visible = true): Promise<BrowserViewStatus> {
  return invoke<BrowserViewStatus>("browser_view_sync", { tab, rect, url: url ?? null, visible })
}

/** Which tab the agent's channel talks to: the one in front. */
export function browserViewActivate(tab: string): Promise<void> {
  return invoke<void>("browser_view_activate", { tab })
}

export function browserViewGo(tab: string, direction: "back" | "forward"): Promise<void> {
  return invoke<void>("browser_view_go", { tab, direction })
}

export function browserViewReload(tab: string): Promise<void> {
  return invoke<void>("browser_view_reload", { tab })
}

export function browserViewStop(tab: string): Promise<void> {
  return invoke<void>("browser_view_stop", { tab })
}

export function browserViewClose(tab: string): Promise<void> {
  return invoke<void>("browser_view_close", { tab })
}

/**
 * Close every browser view the frontend no longer has a tab for.
 *
 * A reload rebuilds the frontend's state from nothing, so its tabs are gone —
 * but the native views are owned by the app process and outlive that document,
 * leaving a page on screen with no tab and no way to close it. Called once on
 * startup with the tabs that do exist, which is the only moment the frontend
 * knows the whole truth.
 */
export function browserViewReconcile(tabs: string[]): Promise<number> {
  return invoke<number>("browser_view_reconcile", { tabs })
}

/**
 * The page's own words, plus whether it is still loading.
 *
 * One call, not two: the toolbar's title, its address and its stop/reload button
 * all come from the same poll, and every extra round trip is one the poll pays
 * for every tab, every second and a half.
 */
export function browserViewPage(tab: string): Promise<{ title: string; url: string; loading: boolean }> {
  return invoke<{ title: string; url: string; loading: boolean }>("browser_view_page", { tab })
}
