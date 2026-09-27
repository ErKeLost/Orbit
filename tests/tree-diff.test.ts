import { describe, expect, test } from "bun:test"
import type { DesktopNode } from "../src-tauri/resources/computer-use/desktop-driver"
import { describeDiff, diffTrees, findNodeByIdentity } from "../src-tauri/resources/computer-use/tree-diff"
import type { DesktopCandidate } from "../src-tauri/resources/computer-use/gui-task-contract"

const node = (overrides: Partial<DesktopNode> & { role: string }): DesktopNode => ({ ...overrides })

describe("tree diff", () => {
  test("reports added and removed nodes by role and label", () => {
    const before: DesktopNode = node({ role: "window", children: [node({ role: "button", name: "Play" })] })
    const after: DesktopNode = node({ role: "window", children: [node({ role: "button", name: "Play" }), node({ role: "menu", name: "操作" }), node({ role: "menuitem", name: "播放" })] })
    const diff = diffTrees(before, after)
    expect(diff.added).toEqual(["menu \"操作\"", "menuitem \"播放\""])
    expect(diff.removed).toEqual([])
    expect(describeDiff(diff)).toBe("+menu \"操作\"; +menuitem \"播放\"")
  })

  test("reports removals when a popover closes", () => {
    const before: DesktopNode = node({ role: "window", children: [node({ role: "button", name: "Play" }), node({ role: "menu", name: "更多" })] })
    const after: DesktopNode = node({ role: "window", children: [node({ role: "button", name: "Play" })] })
    const diff = diffTrees(before, after)
    expect(diff.removed).toEqual(["menu \"更多\""])
    expect(diff.added).toEqual([])
  })

  test("reports value changes on the same labeled node", () => {
    const before: DesktopNode = node({ role: "window", children: [node({ role: "textfield", name: "搜索", value: "" })] })
    const after: DesktopNode = node({ role: "window", children: [node({ role: "textfield", name: "搜索", value: "private song" })] })
    const diff = diffTrees(before, after)
    expect(diff.valueChanges).toEqual([{ label: "textfield \"搜索\"", from: "", to: "private song" }])
    expect(describeDiff(diff)).toBe("~textfield \"搜索\": \"\" -> \"private song\"")
  })

  test("reports newly focused elements and ignores unchanged focus", () => {
    const field = (focused: boolean) => node({ role: "textfield", name: "composer", states: focused ? ["focused"] : [] })
    const diff = diffTrees(node({ role: "window", children: [field(false)] }), node({ role: "window", children: [field(true)] }))
    expect(diff.focusMovedTo).toBe("textfield \"composer\"")
    const unchanged = diffTrees(node({ role: "window", children: [field(true)] }), node({ role: "window", children: [field(true)] }))
    expect(unchanged.focusMovedTo).toBeUndefined()
  })

  test("an identical tree produces an empty diff with a stable summary", () => {
    const tree: DesktopNode = node({ role: "window", children: [node({ role: "button", name: "Play", value: "00:28" })] })
    const diff = diffTrees(tree, JSON.parse(JSON.stringify(tree)) as DesktopNode)
    expect(diff).toEqual({ added: [], removed: [], valueChanges: [] })
    expect(describeDiff(diff)).toBe("no structural, value or focus change")
  })

  test("tolerates bounds deltas and duplicate labels without false additions", () => {
    const before: DesktopNode = node({ role: "window", children: [node({ role: "list_item", name: "song" }), node({ role: "list_item", name: "song" })] })
    const after: DesktopNode = node({ role: "window", children: [node({ role: "list_item", name: "song", bounds: { x: 0, y: 5, width: 10, height: 10 } }), node({ role: "list_item", name: "song", bounds: { x: 0, y: 20, width: 10, height: 10 } })] })
    expect(diffTrees(before, after).added).toEqual([])
    expect(diffTrees(before, after).removed).toEqual([])
  })
})

describe("node re-identification", () => {
  const candidate = (criteria: Record<string, string>, description = criteria.what ?? ""): DesktopCandidate => ({
    id: "candidate-1",
    operation: "SET_VALUE",
    description,
    criteria,
  })

  test("finds a labeled field by role and label after its value changed", () => {
    const tree: DesktopNode = node({ role: "window", children: [node({ role: "textfield", name: "搜索", value: "private song" })] })
    const found = findNodeByIdentity(tree, candidate({ what: "textfield \"搜索\"" }))
    expect(found?.value).toBe("private song")
  })

  test("finds an anonymous field by observed coordinates", () => {
    const tree: DesktopNode = node({ role: "window", children: [node({ role: "textfield", bounds: { x: 12, y: 34, width: 200, height: 24 }, value: "typed" })] })
    const found = findNodeByIdentity(tree, candidate({ what: "textfield", at: "13,35" }))
    expect(found?.value).toBe("typed")
  })

  test("returns undefined for an unresolvable identity instead of guessing", () => {
    const tree: DesktopNode = node({ role: "window", children: [node({ role: "textfield", name: "其它" })] })
    expect(findNodeByIdentity(tree, candidate({ what: "textfield \"搜索\"" }))).toBeUndefined()
  })
})
