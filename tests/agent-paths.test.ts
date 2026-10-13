import { describe, expect, test } from "bun:test"
import {
  agentPathName,
  joinAgentPath,
  resolveAgentPath,
  ROOT_PATH,
  validateAgentName,
  validateAgentPath,
} from "../src-tauri/resources/subagents/paths"

// These mirror Codex's own tests in codex-rs/protocol/src/agent_path.rs so the
// behaviour cannot drift from the design this is borrowed from.

describe("agent paths", () => {
  test("root has the expected name", () => {
    expect(ROOT_PATH).toBe("/root")
    expect(agentPathName("/root")).toBe("root")
    expect(validateAgentPath("/root")).toBeUndefined()
  })

  test("join builds child paths", () => {
    expect(joinAgentPath("/root", "researcher")).toBe("/root/researcher")
    expect(joinAgentPath("/root/researcher", "worker")).toBe("/root/researcher/worker")
    // A spawner path never accumulates trailing slashes.
    expect(joinAgentPath("/root/researcher/", "worker")).toBe("/root/researcher/worker")
  })

  test("join rejects unusable names", () => {
    expect(validateAgentName("BadName")).toBe("task_name must use only lowercase letters, digits, and underscores")
    expect(validateAgentName("has space")).toBe("task_name must use only lowercase letters, digits, and underscores")
    expect(validateAgentName("with/slash")).toBe("task_name must not contain `/`")
    expect(validateAgentName("root")).toBe("task_name `root` is reserved")
    expect(validateAgentName("..")).toBe("task_name `..` is reserved")
    expect(validateAgentName("")).toBe("task_name must not be empty")
    for (const name of ["BadName", "root", "..", "", "a b", "a/b"]) expect(joinAgentPath("/root", name)).toBeUndefined()
  })

  test("resolve supports relative and absolute references", () => {
    expect(resolveAgentPath("/root/researcher", "worker")).toBe("/root/researcher/worker")
    expect(resolveAgentPath("/root/researcher", "/root/other")).toBe("/root/other")
    expect(resolveAgentPath("/root/researcher", "/root")).toBe("/root")
    // A root agent's relative reference is just a top-level child.
    expect(resolveAgentPath("/root", "worker")).toBe("/root/worker")
  })

  test("resolve rejects invalid references", () => {
    expect(resolveAgentPath("/root", "")).toBeUndefined()
    expect(resolveAgentPath("/root", "../sibling")).toBeUndefined()
    expect(resolveAgentPath("/root/researcher", "worker/")).toBeUndefined()
    expect(resolveAgentPath("/root", "/not-root")).toBeUndefined()
    expect(resolveAgentPath("/root", "/root/")).toBeUndefined()
  })

  test("validates absolute paths under /root only", () => {
    expect(validateAgentPath("/root/a/b_c1")).toBeUndefined()
    expect(validateAgentPath("/not-root")).toBe("absolute agent paths must start with `/root`")
    expect(validateAgentPath("root")).toBe("absolute agent paths must start with `/root`")
    expect(validateAgentPath("/root/")).toBe("absolute agent path must not end with `/`")
    expect(validateAgentPath("/root/Bad")).toBe("task_name must use only lowercase letters, digits, and underscores")
    // `root` is reserved as a *child* segment, not as the root itself.
    expect(validateAgentPath("/root/root")).toBe("task_name `root` is reserved")
  })

  test("a name round-trips through a path", () => {
    const path = joinAgentPath("/root", "arch_pipeline")!
    expect(agentPathName(path)).toBe("arch_pipeline")
    expect(path).toBe("/root/arch_pipeline")
  })
})
