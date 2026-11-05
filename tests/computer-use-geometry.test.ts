// Geometric candidates: the rows an accessibility tree proves exist but gives
// no action for. The shape below is a WebView result row: the title, artist and
// duration are separate static texts on one baseline, and none of them is
// pressable — the same shape the live 汽水音乐 window published.
import { describe, expect, test } from "bun:test"
import { geometricCandidates } from "../src-tauri/resources/computer-use/candidates/geometry.ts"
import type { CuaObservation } from "../src-tauri/resources/computer-use/cua/types.ts"

function observation(overrides: Partial<CuaObservation> = {}): CuaObservation {
  const element = (role: string, label: string, x: number, y: number, w = 40, h = 18) => ({
    elementIndex: Math.round(x + y),
    role,
    depth: 3,
    label,
    actions: ["AXShowMenu", "AXScrollToVisible"],
    frame: { x, y, w, h },
    enabled: true,
  })
  return {
    pid: 663,
    windowId: 77,
    app: "汽水音乐",
    title: "汽水音乐",
    elements: [
      element("AXStaticText", "蓝", 834, 599, 15),
      element("AXStaticText", "石白其", 856, 600, 42, 16),
      element("AXStaticText", "04:31", 1656, 600, 36),
      element("AXStaticText", "无人懂的累", 834, 700),
      element("AXStaticText", "开心果果", 856, 700),
    ],
    complete: true,
    truncated: false,
    total: 5,
    captureId: "capture_abc",
    windowBounds: { x: 524, y: 248, w: 1512, h: 832 },
    screenshot: { width: 1366, height: 752 },
    context: "",
    lines: [],
    fingerprint: "fp",
    ...overrides,
  } as CuaObservation
}

const goal = "在汽水音乐里搜索“石白其的蓝”，播放搜索结果里的第一首"

describe("geometric candidates", () => {
  test("a goal-named row becomes one pointer candidate at the row's own label", () => {
    const candidates = geometricCandidates(observation(), goal, false)
    expect(candidates).toHaveLength(1)
    const [first] = candidates
    expect(first.tool).toBe("click")
    expect(first.escalated).toBe(true)
    expect(first.args.capture_id).toBe("capture_abc")
    // The named label on the row is the anchor (石白其 sits next to the title
    // "蓝" on the same baseline), and the point is converted from screen space
    // into window-local screenshot pixels: ((877-524)*0.903, (608-248)*0.903).
    expect(first.args.x).toBe(319)
    expect(first.args.y).toBe(325)
    expect(first.description).toContain("accessibility exposes no action")
  })

  test("without window bounds the point stays in the frame's own space", () => {
    const bare = observation({ windowBounds: undefined })
    const candidates = geometricCandidates(bare, goal, false)
    expect(candidates[0].args.x).toBe(877)
  })

  test("without a capture the coordinates are not deliverable, so nothing is offered", () => {
    expect(geometricCandidates(observation({ captureId: undefined }), goal, false)).toHaveLength(0)
  })

  test("a read-only run never builds a pointer click", () => {
    expect(geometricCandidates(observation(), goal, true)).toHaveLength(0)
  })

  test("rows the goal does not name are left alone", () => {
    expect(geometricCandidates(observation(), "在汽水音乐里播放一首歌，随便哪首都行", false)).toHaveLength(0)
  })

  test("a named label on its own is a control, not a row", () => {
    const lonely = observation()
    lonely.elements = [
      { elementIndex: 1, role: "AXStaticText", depth: 2, label: "播放全部 1", actions: ["AXShowMenu"], frame: { x: 1014, y: 500, w: 67, h: 16 }, enabled: true },
    ]
    const candidates = geometricCandidates(lonely, "点击“播放全部 1”开始播放", false)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].description).toStartWith("click \"播放全部 1\"")
    // ((1048-524)*0.903, (508-248)*0.903) in window-local screenshot pixels.
    expect(candidates[0].args.x).toBe(473)
    expect(candidates[0].args.y).toBe(235)
  })

  test("a positional goal points at the first row of the detected list, not the navigation rail", () => {
    const element = (role: string, label: string, x: number, y: number, w = 40) => ({
      elementIndex: x + y, role, depth: 3, label,
      actions: ["AXShowMenu", "AXScrollToVisible"],
      frame: { x, y, w, h: 18 }, enabled: true,
    })
    const list = observation({
      windowBounds: { x: 0, y: 0, w: 1000, h: 800 },
      screenshot: { width: 1000, height: 800 },
      elements: [
        // Navigation rail: same shape, leftmost column, must never be picked.
        element("AXStaticText", "推荐", 30, 100),
        element("AXStaticText", "听歌模式", 30, 144),
        element("AXStaticText", "我喜欢的音乐", 30, 188),
        // Result list: one pitch, to the right of the rail.
        element("AXStaticText", "蓝", 300, 400, 15),
        element("AXStaticText", "石白其", 320, 400, 42),
        element("AXStaticText", "无人懂的累", 300, 456, 60),
        element("AXStaticText", "开心果果", 320, 456, 42),
        element("AXStaticText", "留白", 300, 512, 30),
        element("AXStaticText", "张碧晨", 320, 512, 42),
      ],
    })
    const candidates = geometricCandidates(list, "播放搜索结果里的第一首", false)
    expect(candidates.length).toBeGreaterThan(0)
    // Row one starts at y=400; the rail sits at x=30 and is never anchored.
    expect(candidates[0].args.y).toBe(409)
    expect(candidates[0].args.x).toBe(308)
    expect(candidates[0].label).toBe("蓝")
  })

  test("a positional goal with no detectable list offers nothing", () => {
    expect(geometricCandidates(observation(), "播放第一首", false)).toHaveLength(0)
  })

  test("a label shorter than two characters never anchors a click", () => {
    const narrow = observation()
    narrow.elements = [
      { elementIndex: 1, role: "AXStaticText", depth: 2, label: "蓝", actions: ["AXShowMenu"], frame: { x: 834, y: 599, w: 15, h: 18 }, enabled: true },
    ]
    expect(geometricCandidates(narrow, "播放蓝", false)).toHaveLength(0)
  })
})
