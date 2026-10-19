import { beforeEach, describe, expect, test } from "bun:test"
import { browserTabPaths, newWorkspaceTab, useShell } from "../src/features/shell/shellStore"

/**
 * A link inside the app goes to the app's own browser column.
 *
 * This is the difference the user sees: clicking a URL in a reply opens the page
 * beside the conversation, in the same window, and a second link navigates that
 * page instead of stacking a new tab next to it. The column belongs to the
 * window, so nothing the pane grid or the workspace tabs do can take the page
 * away from the reader.
 */
const tabs = () => useShell.getState().browserTabs
const browserTabs = () => browserTabPaths(tabs())
const url = (path: string) => tabs().find((tab) => tab.path === path)?.url
const current = () => useShell.getState().workspaces[0]!

beforeEach(() => {
  const workspace = newWorkspaceTab("/repo", "c1")
  useShell.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id, activeByProject: {}, browserTabs: [], browserActive: null, browserOpen: false })
})

describe("links open in the browser column", () => {
  test("the first link opens the column with one page", () => {
    const path = useShell.getState().openLink("https://www.binance.com/zh-CN")
    expect(browserTabs()).toEqual([path])
    expect(url(path)).toBe("https://www.binance.com/zh-CN")
    // It is not a pane: the conversation keeps the whole grid.
    expect(Object.keys(current().panes)).toEqual([])
    expect(useShell.getState().browserOpen).toBe(true)
    expect(useShell.getState().browserActive).toBe(path)
  })

  test("the next link navigates the page that is already open", () => {
    const first = useShell.getState().openLink("https://a.example/one")
    const second = useShell.getState().openLink("https://b.example/two")
    expect(second).toBe(first)
    expect(browserTabs()).toEqual([first])
    expect(url(first)).toBe("https://b.example/two")
  })

  test("a page that was closed is replaced by a fresh one", () => {
    const first = useShell.getState().openLink("https://a.example/one")
    useShell.getState().closeFile(first)
    expect(browserTabs()).toEqual([])
    const second = useShell.getState().openLink("https://b.example/two")
    expect(second).not.toBe(first)
    expect(url(second)).toBe("https://b.example/two")
  })

  test("never piggybacks on the page a browser run is driving", () => {
    // `browser:open` carries the tab id the app minted for a run, and that run
    // closes its tab when it finishes. Navigating it from a link would make the
    // page vanish from under the reader a moment later.
    const runTab = useShell.getState().openBrowser("https://agent.example/", { path: "browser:runtab01" })
    const linkTab = useShell.getState().openLink("https://www.binance.com/zh-CN")
    expect(linkTab).not.toBe(runTab)
    expect(url(runTab)).toBe("https://agent.example/")
    expect(url(linkTab)).toBe("https://www.binance.com/zh-CN")
    expect(browserTabs().sort()).toEqual([runTab, linkTab].sort())
    // The user's own page is still the one later links reuse.
    expect(useShell.getState().openLink("https://c.example/three")).toBe(linkTab)
  })

  test("the pages outlive the panes and workspaces they were opened from", () => {
    // The column is the window's: switching to another workspace tab, closing
    // the conversation's pane or a split changes nothing here.
    const first = useShell.getState().openLink("https://a.example/one")
    const other = newWorkspaceTab("/other", "c2")
    useShell.setState({ workspaces: [...useShell.getState().workspaces, other], activeWorkspaceId: other.id })
    expect(browserTabs()).toEqual([first])
    expect(url(first)).toBe("https://a.example/one")
    // A run closing its own tab leaves the user's page alone.
    const runTab = useShell.getState().openBrowser("https://agent.example/", { path: "browser:runtab02" })
    useShell.getState().closeFile(runTab)
    expect(browserTabs()).toEqual([first])
  })
})
