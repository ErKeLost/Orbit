import { describe, expect, test } from "bun:test"
import {
  replaceProject,
  projectExtraRoots,
  projectFromSelection,
  projectRoots,
  type Project,
} from "../src/lib/projects"

const project = (path: string, roots?: string[]): Project => ({
  path,
  name: path.split("/").pop()!,
  ...(roots ? { roots } : {}),
})

describe("multi-root projects", () => {
  test("一个项目的 roots 去重、主目录永远排第一", () => {
    const value: Project = { path: "/work/app/", name: "app", roots: ["/work/app", "/work/api/", "/work/api", "/work/web"] }
    expect(projectRoots(value)).toEqual(["/work/app", "/work/api", "/work/web"])
    expect(projectExtraRoots(value)).toEqual(["/work/api", "/work/web"])
  })

  test("只有一个目录时不写 roots（主目录已经是它了）", () => {
    expect(projectRoots({ path: "/work/app", name: "app" })).toEqual(["/work/app"])
    expect(projectExtraRoots({ path: "/work/app", name: "app" })).toEqual([])
  })

  test("多选两个目录 = 一个项目，而不是两个项目", () => {
    const selected = projectFromSelection([], ["/work/create-x-backend", "/work/create-x-studio"])
    expect(selected).toMatchObject({
      path: "/work/create-x-backend",
      name: "create-x-backend",
      roots: ["/work/create-x-backend", "/work/create-x-studio"],
    })
    // 落到注册表里也只有一条：`update`（replaceProject）是 upsert，不是 add。
    const registry = replaceProject([], selected!)
    expect(registry).toHaveLength(1)
  })

  test("多选时第二个目录不会另立门户", () => {
    const registry = replaceProject([], projectFromSelection([], ["/work/app", "/work/api"])!)
    expect(registry.map(item => item.path)).toEqual(["/work/app"])
    expect(projectExtraRoots(registry[0]!)).toEqual(["/work/api"])
  })

  test("已经注册过的目录复用名字与外观，roots 并进去不重复", () => {
    const existing: Project = { path: "/work/app", name: "我的产品", customColor: "#3b82f6", pinned: true, roots: ["/work/app", "/work/api"] }
    const next = projectFromSelection([existing], ["/work/app", "/work/api/", "/work/web"])
    expect(next).toMatchObject({ name: "我的产品", customColor: "#3b82f6", pinned: true })
    expect(projectExtraRoots(next!)).toEqual(["/work/api", "/work/web"])
  })

  test("选同一个目录两次仍然是一个 root", () => {
    const next = projectFromSelection([], ["/work/app/", "/work/app"])
    expect(projectRoots(next!)).toEqual(["/work/app"])
  })

  test("没有选中任何目录时什么都不做", () => {
    expect(projectFromSelection([], [])).toBeNull()
  })
})
