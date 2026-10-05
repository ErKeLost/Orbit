import type { ScreenChannelSnapshot } from "./remote-screen"

/**
 * One sentence that names the broken stage, when the numbers make it obvious.
 * Reads the stages in pipeline order and stops at the first one that is wrong.
 */
export function diagnose(snapshot: ScreenChannelSnapshot): string | null {
  const status = snapshot.status
  const sample = status?.captureSample ?? null
  const readback = snapshot.readback
  if (snapshot.state !== "live") return null
  if (status?.failure) return `电脑端报错：${status.failure}`
  if (status && !status.permission) return "电脑端没有屏幕录制授权。"
  if (sample && sample.maxBrightness < 8) return "电脑采集到的原始画面就是黑的（编码之前），问题在电脑端采集，与手机无关。"
  if (status && status.captured > 0 && status.published === 0) return "电脑在采集，但一帧都没发出去。"
  if (snapshot.diag.received === 0) return "电脑在发送，但手机一帧都没收到：问题在网络或连接。"
  if (snapshot.codec === "h264" && snapshot.diag.decoded === 0) return "手机收到了帧，但没有送进解码器：看下方「最近问题」。"
  if (snapshot.codec === "h264" && snapshot.diag.painted === 0) return "解码器在工作，但没有画到屏幕上。"
  if (sample && sample.maxBrightness >= 8 && readback && readback.brightness >= 0 && readback.maxBrightness < 8) {
    return "电脑采集的画面正常，但手机显示出来是黑的：问题在手机端的解码/绘制。"
  }
  if (sample && sample.maxBrightness >= 8 && readback && readback.maxBrightness >= 8) return "电脑和手机两端的像素都正常。"
  return null
}

/** Plain text for copying: every field, both logs, oldest first. */
export function buildReport(snapshot: ScreenChannelSnapshot): string {
  const status = snapshot.status
  const lines: string[] = [
    `Orbit 屏幕诊断 ${new Date().toISOString()}`,
    `结论：${diagnose(snapshot) ?? "（数据不足以判断）"}`,
    `状态：${snapshot.state}  手机编码：${snapshot.codec ?? "-"}  WebCodecs：${snapshot.webCodecs}`,
    "",
    "[电脑采集]",
    JSON.stringify(status?.captureSample ?? null),
    `display=${JSON.stringify(status?.display ?? null)}`,
    "",
    "[电脑状态]",
    JSON.stringify(status ? { ...status, events: undefined, displays: status.displays?.map(display => display.name) } : null),
    "",
    "[手机]",
    JSON.stringify({ diag: snapshot.diag, decodeRecoveries: snapshot.decodeRecoveries, receivedFps: snapshot.receivedFps, latencyMs: snapshot.latencyMs, rttMs: snapshot.rttMs, frame: snapshot.frame, error: snapshot.error, codecNote: snapshot.codecNote }),
    "",
    "[手机读回]",
    JSON.stringify(snapshot.readback),
    "",
    "[电脑日志]",
    ...(status?.events ?? []).map(event => `${clock(event.atMs)} ${event.message}`),
    "",
    "[手机日志]",
    ...snapshot.log.map(entry => `${clock(entry.at)} ${entry.message}`),
    "",
    `userAgent=${typeof navigator === "undefined" ? "-" : navigator.userAgent}`,
  ]
  return lines.join("\n")
}

export function num(value: number | undefined): string {
  return value === undefined ? "—" : String(value)
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

export function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  return seconds < 2 ? "刚刚" : `${seconds} 秒前`
}

export function clock(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`
}

export function formatBits(bits: number): string {
  if (bits >= 1_000_000) return `${(bits / 1_000_000).toFixed(1)} Mbps`
  if (bits >= 1_000) return `${Math.round(bits / 1_000)} kbps`
  return `${Math.round(bits)} bps`
}
