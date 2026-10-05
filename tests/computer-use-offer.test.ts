// Real-window regression tests for the offer set and the observation budget.
//
// The fixture is an unmodified `ax_control` snapshot of the 汽水音乐 player on
// macOS (Electron/CEF): 264 nodes, no `button` role anywhere, and a transport
// bar of three anonymous groups. This is the shape that broke the previous
// implementation: a fixed node cap ranked the play button 257th of 264 and cut
// it before any candidate was built, so the decision model could never choose
// it no matter how it was prompted.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { DesktopDriver, DesktopEnvelope, DesktopNode } from "../src-tauri/resources/computer-use/desktop-driver"
import { normalizeSnapshot } from "../src-tauri/resources/computer-use/xa11y-client"
import { observeDesktop } from "../src-tauri/resources/computer-use/desktop-observation"
import type { DesktopCandidate, DesktopObservation } from "../src-tauri/resources/computer-use/gui-task-contract"

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

/** The three controls sit under this tree path; their parent is the anonymous
 * cluster container. */
const TRANSPORT_PARENT_PATH = [0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 2]

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

/** The same goal the failing live runs used: no quoted anchor, no prepared text. */
async function observePlayer(): Promise<DesktopObservation> {
  return await observeDesktop(driver, {
    app: "汽水音乐",
    goal: "在汽水音乐里播放一首歌",
    textSlots: [],
    usedSlotIds: new Set(),
    allowPressEnter: false,
  }, { timeoutMs: 5_000 })
}

const renderedLines = (observation: DesktopObservation): string[] => {
  const body = observation.context.split("\ninterface:\n")[1] ?? ""
  return body.split("\n").filter(line => /^\d+\. /.test(line)).map(line => line.replace(/^\d+\. /, ""))
}

const candidatesFor = (observation: DesktopObservation, transport: typeof TRANSPORT[number]): DesktopCandidate[] =>
  observation.candidates.filter(candidate => {
    const path = candidate.ref ? (JSON.parse(candidate.ref) as { path?: number[] }).path : undefined
    const node = path ? pathAt(fixture.tree, path) : undefined
    return node?.bounds?.x === transport.x && node.bounds.y === 1266 && node.bounds.width === transport.width
  })

describe("offer set on a real Electron player window", () => {
  test("offers the anonymous transport bar so the play button is reachable", async () => {
    const observation = await observePlayer()
    const lines = renderedLines(observation)

    for (const transport of TRANSPORT) {
      // Exactly one click candidate: the element is the target, delivery is not.
      const clicks = candidatesFor(observation, transport).filter(candidate => candidate.operation === "CLICK")
      expect(clicks).toHaveLength(1)
      // The rendered interface carries the discriminating geometry, because the
      // labels cannot carry it.
      expect(lines.some(line => line.includes(`at ${transport.x},1266`))).toBe(true)
    }

    const play = candidatesFor(observation, TRANSPORT[1]).find(candidate => candidate.operation === "CLICK")!
    expect(play.criteria?.structure).toContain("cluster 2/3 center size-rank 1 84x48")
    expect(lines.find(line => line.includes("at 1238,1266")))
      .toBe('click · group embedded control · cluster 2/3 center size-rank 1 84x48 · at 1238,1266')
  })

  test("offers exactly one candidate per target and operation", async () => {
    const observation = await observePlayer()
    const pairs = observation.candidates.filter(candidate => candidate.ref).map(candidate => `${candidate.operation}:${pathOf(candidate)}`)
    // Two deliveries for one element is the option-level overlap that makes a
    // choice look uncertain; the engine owns semantic-then-pointer escalation.
    expect(pairs.length).toBe(new Set(pairs).size)
  })

  test("withholds the anonymous cluster container that merely wraps the controls", async () => {
    const observation = await observePlayer()
    const parent = JSON.stringify(TRANSPORT_PARENT_PATH)
    expect(pathAt(fixture.tree, TRANSPORT_PARENT_PATH)?.bounds).toEqual({ x: 1156, y: 1266, width: 248, height: 48 })
    // Offering the wrapper lets it compete with the controls it contains.
    expect(observation.candidates.filter(candidate => pathOf(candidate) === parent && candidate.operation !== "RIGHT_CLICK")).toHaveLength(0)
  })

  test("keeps the observation inside the text budget and reports pruning", async () => {
    const observation = await observePlayer()
    expect(observation.context.length).toBeLessThanOrEqual(8_000)
    expect(observation.context).toContain("elements_actionable=264")
    expect(observation.context).toContain("pruned_structural=60")
    expect(observation.context).toContain("offered=204")
    // The safety net must not be what decides which controls Jev can see; the
    // header names it explicitly the moment it applies.
    expect(observation.context).not.toContain("node_cap_applied")
  })

  test("renders a stable interface golden", async () => {
    const observation = await observePlayer()
    const lines = renderedLines(observation)
    expect(lines.slice(0, 12)).toEqual([
      'click · group "创建歌单"',
      'click · group containing "VIP" · cluster 2/3 size-rank 3 27x17',
      'click · group containing "关注" · cluster 2/2 size-rank 1 41x21',
      "click · group embedded control · at 1335,886",
      'click · group containing "作词：赵大白/林晨阳" · row 1/11',
      'double_click · group containing "作词：赵大白/林晨阳" · row 1/11',
      'click · group containing "作曲：刘昊霖" · row 2/11',
      'double_click · group containing "作曲：刘昊霖" · row 2/11',
      'click · group containing "月亮还醒着它" · row 3/11',
      'double_click · group containing "月亮还醒着它" · row 3/11',
      'click · group containing "是不是不快乐" · row 4/11',
      'double_click · group containing "是不是不快乐" · row 4/11',
    ])
    // The whole offer set is offered; the text is what is bounded.
    expect(observation.candidates.filter(candidate => candidate.ref)).toHaveLength(316)
    expect(lines).toHaveLength(122)
  })

  test("keeps the search field first and typeable when the caller prepared text", async () => {
    const withSlot = await observeDesktop(driver, {
      app: "汽水音乐",
      goal: "在汽水音乐里搜索这首歌",
      textSlots: [{ id: "query", value: "风莫归影", description: "要搜索的歌名" }],
      usedSlotIds: new Set(),
      allowPressEnter: false,
    }, { timeoutMs: 5_000 })
    const lines = renderedLines(withSlot)
    // A field with no prepared text has nothing to do but offer a context menu,
    // so it is rendered last; the moment text exists it must lead the list.
    const field = withSlot.candidates.filter(candidate => (candidate.criteria?.what ?? "").startsWith("text_field"))
    // Chromium needs real key events, so the offered text route is physical
    // typing rather than a semantic value write.
    expect(field.map(candidate => candidate.operation)).toContain("TYPE_TEXT")
    expect(lines[0]).toContain("text_field")
    expect(withSlot.context.length).toBeLessThanOrEqual(8_000)
  })
})
