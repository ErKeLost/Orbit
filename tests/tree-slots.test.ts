import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TreeSlots } from "../src-tauri/resources/subagents/tree-slots.ts"

const fixture = () => mkdtempSync(join(tmpdir(), "orbit-tree-slots-"))

describe("tree slots", () => {
  test("charges one slot per running worker and refuses past the budget", () => {
    const slots = new TreeSlots(fixture(), 2)
    const first = slots.acquire()
    const second = slots.acquire()

    // A delegation loop that nests must fail loudly rather than fork bomb.
    expect(() => slots.acquire()).toThrow(/整棵 agent 树的并发已满/)
    expect(() => slots.acquire()).toThrow(/最多 2 个/)

    slots.release(first)
    expect(() => slots.acquire()).not.toThrow()
    slots.release(second)
    slots.dispose()
  })

  test("releases the slot of a process that died without cleaning up", () => {
    const dir = fixture()
    const slots = new TreeSlots(dir, 1)
    // A slot left behind by a crashed process: pid 1 is alive, so pick a pid that
    // cannot exist and claim a slot with it by hand.
    const dead = join(dir, "slots", "99999999-crashed")
    slots.acquire()
    writeFileSync(dead, JSON.stringify({ pid: 99_999_999, at: Date.now() }))

    // The stale slot is reclaimed instead of shrinking the budget forever.
    const second = new TreeSlots(dir, 2)
    expect(() => second.acquire()).not.toThrow()
    expect(existsSync(dead)).toBe(false)
    second.dispose()
  })

  test("dispose gives back everything it owns", () => {
    const dir = fixture()
    const slots = new TreeSlots(dir, 3)
    slots.acquire()
    slots.acquire()
    const slotDir = join(dir, "slots")
    expect(readdirSync(slotDir).length).toBe(2)
    slots.dispose()
    expect(existsSync(slotDir)).toBe(false)
  })
})
