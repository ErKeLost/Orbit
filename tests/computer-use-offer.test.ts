// Real-window regression tests for the offer set, the element table and the
// request budget.
//
// The fixture is an unmodified `ax_control` snapshot of a macOS Electron/CEF
// player: 264 nodes, no `button` role anywhere, and a transport bar of three
// anonymous groups. This is the shape that broke the previous implementation in
// two different ways, and each test below pins one of them:
//
//   1. ranking + a fixed node cap evicted the play button before any candidate
//      was built, so the decision model could never choose it;
//   2. removing the cap exposed what the ranking had been hiding — the engine
//      generated ~190K characters of request payload for this window, over the
//      model's input budget, and every turn failed outright.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { DesktopDriver, DesktopEnvelope, DesktopNode } from "../src-tauri/resources/computer-use/desktop-driver"
import { normalizeSnapshot } from "../src-tauri/resources/computer-use/xa11y-client"
import { observeDesktop } from "../src-tauri/resources/computer-use/desktop-observation"
import { OBSERVATION_CHARS, REQUEST_CHARS, type DesktopCandidate, type DesktopObservation } from "../src-tauri/resources/computer-use/gui-task-contract"

const fixture = normalizeSnapshot(
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures/computer-use/soda-music-player.json"), "utf8")),
)

/** Transport-bar buttons are identified by the geometry that proves them: three
 * same-shaped groups in one row at y=1266, the middle one wider than its
 * neighbours. Nothing else distinguishes them, because all three are nameless. */
const TRANSPORT = [
  { name: "上一首", x: 1162, width: 64 },
  { name: "播放/暂停", x: 1238, width: 84 },
  { name: "下一首", x: 1334, width: 64 },
] as const

const driver: DesktopDriver = {
  async run<T>(args: string[]): Promise<DesktopEnvelope<T>> {
    const command = args[0]
    const data = command === "snapshot"
      ? fixture
      : command === "now-playing"
        ? { available: true, title: "风莫归影", artist: "王睿卓", playing: false }
        : { items: [] }
    return { version: "orbit.ax.v1", ok: true, command, data } as DesktopEnvelope<T>
  },
  async dispose() { /* nothing to release */ },
}

function pathAt(root: DesktopNode, path: number[]): DesktopNode | undefined {
  let current: DesktopNode | undefined = root
  for (const index of path) current = current?.children?.[index]
  return current
}

const pathOf = (candidate: DesktopCandidate): string =>
  candidate.ref ? JSON.stringify((JSON.parse(candidate.ref) as { path?: number[] }).path) : ""

const boundsOf = (candidate: DesktopCandidate) => {
  const path = candidate.ref ? (JSON.parse(candidate.ref) as { path?: number[] }).path : undefined
  return path ? pathAt(fixture.tree, path)?.bounds : undefined
}

/** The same goal the failing live runs used: no quoted anchor, no prepared text. */
async function observePlayer(goal = "在汽水音乐里播放一首歌曲，让音乐真正开始播放"): Promise<DesktopObservation> {
  return await observeDesktop(driver, {
    app: "汽水音乐",
    goal,
    textSlots: [],
    usedSlotIds: new Set(),
    allowPressEnter: false,
  }, { timeoutMs: 5_000 })
}

/** The element table is the readable interface: one line per element. */
const tableLines = (observation: DesktopObservation): string[] =>
  (observation.context.split("\nelements:\n")[1] ?? "").split("\n").filter(line => line.startsWith("["))

const indexOfCandidate = (candidate: DesktopCandidate): number | undefined =>
  /^\[(\d+)\]/.exec(candidate.criteria?.what ?? "")?.[1] !== undefined
    ? Number(/^\[(\d+)\]/.exec(candidate.criteria!.what)![1])
    : undefined

describe("offer set on a real Electron player window", () => {
  test("lists every element that carries an operation, and nothing else", async () => {
    const observation = await observePlayer()
    const refs = new Set(observation.candidates.filter(candidate => candidate.ref).map(candidate => candidate.ref!))
    const lines = tableLines(observation)
    // The defect this pins: a control that has a candidate but is missing from
    // the readable interface can never be chosen, however the prompt is worded.
    expect(lines).toHaveLength(refs.size)
    // The table states exactly what can be done, once per element.
    for (const line of lines) expect(line).toMatch(/^\[\d+\] /)
    expect(observation.context).not.toContain("table_over_budget")
  })

  test("refers to targets by the same index the table uses", async () => {
    const observation = await observePlayer()
    const listed = new Set(tableLines(observation).map(line => /^\[(\d+)\]/.exec(line)![1]))
    for (const candidate of observation.candidates) {
      if (!candidate.ref || !candidate.criteria) continue
      const index = indexOfCandidate(candidate)
      expect(index).toBeDefined()
      expect(listed.has(String(index))).toBe(true)
    }
  })

  test("reserves the play button a line with the geometry that identifies it", async () => {
    const observation = await observePlayer()
    const lines = tableLines(observation)
    for (const transport of TRANSPORT) {
      const line = lines.find(candidate => candidate.includes(`at ${transport.x},1266`))
      expect(line).toBeDefined()
      expect(line).toContain("click")
    }
    const play = lines.find(line => line.includes("at 1238,1266"))!
    // The middle control is the only one that is centred and the only one whose
    // size ranks first; that is all the accessibility tree exposes.
    expect(play).toContain("cluster 2/3 center size-rank 1 84x48")
    const clicks = observation.candidates.filter(candidate => candidate.operation === "CLICK" && boundsOf(candidate)?.x === 1238)
    expect(clicks).toHaveLength(1)
  })

  test("offers exactly one candidate per target and operation", async () => {
    const observation = await observePlayer()
    const pairs = observation.candidates.filter(candidate => candidate.ref).map(candidate => `${candidate.operation}:${pathOf(candidate)}`)
    // Two deliveries for one element is option-level overlap: it reads as doubt
    // to a decision model. Delivery escalation belongs to the engine.
    expect(pairs.length).toBe(new Set(pairs).size)
  })

  test("keeps every question inside the protocol's option ceiling", async () => {
    const observation = await observePlayer()
    const byOperation = new Map<string, Set<string>>()
    for (const candidate of observation.candidates) {
      const group = byOperation.get(candidate.operation) ?? new Set<string>()
      group.add(candidate.criteria?.what ?? candidate.id)
      byOperation.set(candidate.operation, group)
    }
    for (const [operation, options] of byOperation) {
      // One question is asked per operation; the service rejects a question with
      // more than 255 options outright.
      expect({ operation, options: options.size }).toEqual({ operation, options: expect.any(Number) })
      expect(options.size).toBeLessThanOrEqual(255)
    }
  })

  test("keeps the observation inside its declared budget", async () => {
    const observation = await observePlayer()
    expect(observation.context.length).toBeLessThanOrEqual(OBSERVATION_CHARS)
    // The observation and the questions share one input budget, so the
    // observation must leave the offer set the larger share.
    expect(OBSERVATION_CHARS).toBeLessThan(REQUEST_CHARS / 2)
    expect(observation.context).toContain("elements=")
    expect(observation.context).toContain("pruned=")
  })

  test("keeps the search field typeable and referenced by its table index", async () => {
    const withSlot = await observeDesktop(driver, {
      app: "汽水音乐",
      goal: "在汽水音乐里搜索这首歌",
      textSlots: [{ id: "query", value: "风莫归影", description: "要搜索的歌名" }],
      usedSlotIds: new Set(),
      allowPressEnter: false,
    }, { timeoutMs: 5_000 })
    const field = withSlot.candidates.filter(candidate => (candidate.criteria?.what ?? "").includes("text_field"))
    // Chromium needs real key events, so the offered text route is physical
    // typing rather than a semantic value write.
    expect(field.map(candidate => candidate.operation)).toContain("TYPE_TEXT")
    const index = indexOfCandidate(field[0])!
    expect(tableLines(withSlot).some(line => line.startsWith(`[${index}] `) && line.includes("editable"))).toBe(true)
  })

  test("renders a stable interface golden", async () => {
    const observation = await observePlayer()
    const lines = tableLines(observation)
    expect(lines.slice(0, 10)).toEqual([
      '[2] link "推荐" · 1/6 · right_click',
      '[3] group containing "推荐" · cluster 2/2 center size-rank 1 28x20 · drill',
      '[5] link "听歌模式" · 2/6 · right_click',
      '[6] group containing "听歌模式" · cluster 2/2 center size-rank 1 56x20 · drill',
      '[7] group containing "听歌模式" · drill',
      '[10] link "我喜欢的音乐" · 3/6 · right_click',
      '[11] group containing "我喜欢的音乐" · cluster 2/2 center size-rank 1 84x20 · drill',
      '[13] link "抖音收藏的音乐" · 4/6 · right_click',
      '[14] group containing "抖音收藏的音乐" · cluster 2/2 center size-rank 1 98x20 · drill',
      '[16] link "历史播放" · 5/6 · right_click',
    ])
    // The whole window is described; nothing was dropped to fit.
    expect(lines).toHaveLength(140)
    expect(observation.candidates.filter(candidate => candidate.ref)).toHaveLength(230)
  })
})
