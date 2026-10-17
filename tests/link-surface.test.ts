import { beforeEach, describe, expect, test } from "bun:test"
import { browserTabPaths, newWorkspaceTab, useShell } from "../src/features/shell/shellStore"

/**
 * A link inside the app goes to the app's own browser column.
 *
 * This is the difference the user sees: clicking a URL in a reply opens the page
 * beside the conversation, in the same window, and a second link navigates that
 * page instead of stacking a new split and a new tab next to it.
 */
const browserTabs = () => browserTabPaths(useShell.getState().workspaces)

const current = () => useShell.getState().workspaces[0]!

const browserUrl = (path: string) =>
  Object.values(current().panes).flatMap((pane) => pane.files).find((file) => file.path === path)?.browser?.url

beforeEach(() => {
  const workspace = newWorkspaceTab("/repo", "c1")
  useShell.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id, activeByProject: {} })
})

describe("links open in the browser column", () => {
  test("the first link opens a browser pane of its own on the right", () => {
    const path = useShell.getState().openLink("https://www.binance.com/zh-CN")
    expect(browserTabs()).toEqual([path])
    expect(browserUrl(path)).toBe("https://www.binance.com/zh-CN")
    // Its own pane: the conversation and whatever was open beside it stay put.
    expect(Object.keys(current().panes)).toEqual(["editor:1"])
    expect(current().activePane).toBe("editor:1")
  })

  test("the next link navigates the page that is already open", () => {
    const first = useShell.getState().openLink("https://a.example/one")
    const second = useShell.getState().openLink("https://b.example/two")
    expect(second).toBe(first)
    // One tab, one pane, and the address is the newer one.
    expect(browserTabs()).toEqual([first])
    expect(Object.keys(current().panes)).toHaveLength(1)
    expect(browserUrl(first)).toBe("https://b.example/two")
  })

  test("a workspace whose browser tab is gone opens a fresh one", () => {
    const first = useShell.getState().openLink("https://a.example/one")
    useShell.getState().closeFile(first)
    expect(browserTabs()).toEqual([])
    const second = useShell.getState().openLink("https://b.example/two")
    expect(second).not.toBe(first)
    expect(browserUrl(second)).toBe("https://b.example/two")
  })

  test("never piggybacks on the page a browser run is driving", () => {
    // `browser:open` carries the tab id the app minted for a run, and that run
    // closes its tab when it finishes. Navigating it from a link would make the
    // page vanish from under the reader a moment later.
    const runTab = useShell.getState().openBrowser("https://agent.example/", { path: "browser:runtab01" })
    const linkTab = useShell.getState().openLink("https://www.binance.com/zh-CN")
    expect(linkTab).not.toBe(runTab)
    expect(browserUrl(runTab)).toBe("https://agent.example/")
    expect(browserUrl(linkTab)).toBe("https://www.binance.com/zh-CN")
    // One browser pane, not a second split: the run's tab is one of its tabs, and
    // when the run closes it the page the user clicked is the one left behind.
    expect(Object.keys(current().panes)).toHaveLength(1)
    expect(browserTabs().sort()).toEqual([runTab, linkTab].sort())
    // The user's own page is still the one later links reuse.
    expect(useShell.getState().openLink("https://c.example/three")).toBe(linkTab)
  })
})
