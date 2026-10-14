import { describe, expect, test } from "bun:test"
import { projectWorkspaceTabs, type WorkspaceTab } from "../src/features/shell/shellModel"

/** 只需要 id/cwd，其余字段对 `projectWorkspaceTabs` 无意义。 */
const tab = (id: string, cwd: string) => ({ id, cwd }) as unknown as WorkspaceTab
const home = tab("home", "/a")

describe("project-scoped header tabs", () => {
  test("只显示当前项目的标签页，首页永远不算标签页", () => {
    const tabs = [tab("a1", "/a"), tab("b1", "/b"), tab("a2", "/a/"), home]
    expect(projectWorkspaceTabs(tabs, "/a").map(item => item.id)).toEqual(["a1", "a2"])
    expect(projectWorkspaceTabs(tabs, "/b").map(item => item.id)).toEqual(["b1"])
  })

  test("不同项目的 header 不共享", () => {
    const tabs = [tab("a1", "/a"), tab("b1", "/b")]
    expect(projectWorkspaceTabs(tabs, "/a").map(item => item.id)).not.toContain("b1")
    expect(projectWorkspaceTabs(tabs, "/b").map(item => item.id)).not.toContain("a1")
  })

  test("范围还没确定时退回「全部非首页标签」（冷启动的短暂窗口）", () => {
    expect(projectWorkspaceTabs([tab("a1", "/a"), home], "").map(item => item.id)).toEqual(["a1"])
  })
})
