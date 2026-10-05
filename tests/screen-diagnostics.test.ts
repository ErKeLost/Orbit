import { describe, expect, test } from "bun:test"

const globals = globalThis as unknown as Record<string, unknown>
globals.window ??= { addEventListener() {}, removeEventListener() {} }
globals.localStorage ??= { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }

const { diagnose, buildReport } = await import("../src/lib/screen-diagnostics")
type Snapshot = Parameters<typeof diagnose>[0]

const sample = (maxBrightness: number) => ({
  brightness: maxBrightness / 2, maxBrightness, blackRatio: maxBrightness < 8 ? 1 : 0.1,
  unchangedRatio: 0.2, width: 1080, height: 608, backing: "IOSurface", atMs: Date.now(),
})

function snapshot(overrides: { sample?: ReturnType<typeof sample> | null; readbackMax?: number | null; received?: number; decoded?: number; painted?: number; permission?: boolean; failure?: string; published?: number; codec?: "h264" | "jpeg" } = {}): Snapshot {
  const status = {
    running: true, permission: overrides.permission ?? true, subscribers: 1, codec: overrides.codec ?? "h264",
    source: "display", width: 1080, height: 608, fps: 60, effectiveFps: 30, quality: 90, displays: [],
    captured: 100, published: overrides.published ?? 90, dropped: 0, unchanged: 0, encodeMsAvg: 2, encodeMsMax: 4,
    bitsPerSecond: 1e6, queueDelayMs: 0, failure: overrides.failure, captureSample: overrides.sample === undefined ? sample(200) : overrides.sample,
    keyframes: 3, refreshes: 1, uptimeSeconds: 10, identity: { pid: 1, executable: "/Applications/Orbit.app/Contents/MacOS/orbit", version: "0.5.18", os: "macOS 15" },
    events: [{ atMs: 0, message: "采集开始" }],
  }
  const readback = overrides.readbackMax === null ? null : {
    brightness: (overrides.readbackMax ?? 200) / 2, maxBrightness: overrides.readbackMax ?? 200,
    surface: "canvas" as const, width: 1080, height: 608, error: null, at: Date.now(),
  }
  return {
    state: "live", codec: overrides.codec ?? "h264", status, readback, log: [{ at: 0, message: "收到第一帧" }],
    diag: { received: overrides.received ?? 90, decoded: overrides.decoded ?? 90, painted: overrides.painted ?? 90, noCanvas: 0, waitingForKeyframe: 0, noDecoderConfig: 0, decodeErrors: 0, lastProblem: null },
    receivedFps: 30, latencyMs: 40, rttMs: 20, decodeRecoveries: 0, webCodecs: true,
  } as unknown as Snapshot
}

describe("diagnose names the first broken stage", () => {
  test("black capture on the computer is blamed on the computer, whatever the phone shows", () => {
    expect(diagnose(snapshot({ sample: sample(3), readbackMax: 3 }))).toContain("电脑采集到的原始画面就是黑的")
  })
  test("a good capture shown black on the phone is blamed on the phone", () => {
    expect(diagnose(snapshot({ sample: sample(200), readbackMax: 3 }))).toContain("问题在手机端的解码/绘制")
  })
  test("both ends bright is reported as healthy", () => {
    expect(diagnose(snapshot({ sample: sample(200), readbackMax: 200 }))).toContain("两端的像素都正常")
  })
  test("nothing received is the link", () => {
    expect(diagnose(snapshot({ received: 0, decoded: 0, painted: 0 }))).toContain("手机一帧都没收到")
  })
  test("a host failure wins over everything after it", () => {
    expect(diagnose(snapshot({ failure: "采集失败：x", sample: sample(3) }))).toContain("电脑端报错")
  })
  test("missing permission is named", () => {
    expect(diagnose(snapshot({ permission: false }))).toContain("没有屏幕录制授权")
  })
  test("JPEG does not report a missing H.264 decoder", () => {
    // In JPEG mode the decoder counters stay at zero by design.
    expect(diagnose(snapshot({ codec: "jpeg", decoded: 0, painted: 0, readbackMax: 200 }))).toContain("两端的像素都正常")
  })
})

describe("buildReport", () => {
  test("carries the verdict and both logs as text", () => {
    const text = buildReport(snapshot({ sample: sample(3) }))
    expect(text).toContain("结论：电脑采集到的原始画面就是黑的")
    expect(text).toContain("[电脑日志]")
    expect(text).toContain("采集开始")
    expect(text).toContain("[手机日志]")
    expect(text).toContain("收到第一帧")
  })
})
