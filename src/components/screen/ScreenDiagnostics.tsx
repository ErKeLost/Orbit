import { useEffect, useMemo, useState } from "react"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { Button } from "../UI"
import { Icon } from "../Icon"
import { screenChannel, type ScreenChannelSnapshot } from "../../lib/remote-screen"
import { ago, buildReport, clock, diagnose, formatBits, num, pct } from "../../lib/screen-diagnostics"

/**
 * Everything the screen channel knows, on one page, for both ends.
 *
 * A black preview has been impossible to reason about from one number at a
 * time. This shows each stage with its own counter — the computer's capture,
 * its encoder, the link, the phone's decoder, and what the phone actually put
 * on screen — plus both sides' event logs, and copies the lot as text so it can
 * be pasted rather than photographed.
 */
export function ScreenDiagnostics() {
  const [snapshot, setSnapshot] = useState<ScreenChannelSnapshot>(() => screenChannel().current)
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle")
  useEffect(() => screenChannel().subscribe(setSnapshot), [])

  const report = useMemo(() => buildReport(snapshot), [snapshot])
  const status = snapshot.status
  const sample = status?.captureSample ?? null
  const readback = snapshot.readback
  const verdict = diagnose(snapshot)

  async function copy() {
    try {
      await writeText(report)
      setCopied("done")
    } catch {
      try {
        await navigator.clipboard.writeText(report)
        setCopied("done")
      } catch {
        setCopied("failed")
      }
    }
    window.setTimeout(() => setCopied("idle"), 2000)
  }

  return <div className="screen-diagnostics">
    <div className="screen-diagnostics-bar">
      <Button type="button" onClick={() => void copy()}>
        <Icon name="copy" />{copied === "done" ? "已复制" : copied === "failed" ? "复制失败，请长按下方文字" : "复制全部诊断"}
      </Button>
      <span className="screen-diagnostics-state">{STATE_LABELS[snapshot.state] ?? snapshot.state}</span>
    </div>

    {verdict && <p className="screen-diagnostics-verdict" role="status">{verdict}</p>}
    {snapshot.state === "idle" && <p className="screen-hint">先打开屏幕小窗，这里才会有数据。</p>}

    <Section title="① 电脑采集（编码前的原始画面）">
      <Row label="采集画面" value={status?.display ? `${status.display.name}（${status.display.kind === "window" ? "窗口" : "显示器"}）` : "—"} />
      <Row label="已采集帧" value={num(status?.captured)} />
      <Row label="画面亮度" value={sample ? `${sample.brightness.toFixed(1)}（最亮 ${sample.maxBrightness.toFixed(0)}）` : "—"} warn={sample !== null && sample.maxBrightness < 8} />
      <Row label="纯黑像素占比" value={sample ? pct(sample.blackRatio) : "—"} warn={sample !== null && sample.blackRatio > 0.97} />
      <Row label="与上一秒相同" value={sample ? pct(sample.unchangedRatio) : "—"} />
      <Row label="采样尺寸 / 来源" value={sample ? `${sample.width}×${sample.height} · ${sample.backing}` : "—"} />
      <Row label="采样时间" value={sample ? ago(sample.atMs) : "—"} />
    </Section>

    <Section title="② 电脑编码与发送">
      <Row label="编码格式" value={status?.codec ?? "—"} />
      <Row label="已发送 / 跳过 / 未变化" value={status ? `${status.published} / ${status.dropped} / ${status.unchanged}` : "—"} />
      <Row label="关键帧 / 刷新请求" value={status ? `${status.keyframes} / ${status.refreshes}` : "—"} />
      <Row label="实际帧率 / 上限" value={status ? `${status.effectiveFps.toFixed(1)} / ${status.fps}` : "—"} />
      <Row label="画质 / 码率" value={status ? `${status.quality} / ${formatBits(status.bitsPerSecond)}` : "—"} />
      <Row label="单帧编码" value={status ? `${status.encodeMsAvg.toFixed(1)} ms（最长 ${status.encodeMsMax.toFixed(1)}）` : "—"} />
      <Row label="排队延迟" value={status ? `${status.queueDelayMs} ms` : "—"} />
      <Row label="观看端 / 已运行" value={status ? `${status.subscribers} 个 / ${status.uptimeSeconds} 秒` : "—"} />
      <Row label="故障" value={status?.failure ?? "无"} warn={Boolean(status?.failure)} />
    </Section>

    <Section title="③ 手机接收与解码">
      <Row label="编码格式" value={snapshot.codec ?? "—"} />
      <Row label="收到 / 送入解码 / 画出" value={`${snapshot.diag.received} / ${snapshot.diag.decoded} / ${snapshot.diag.painted}`} />
      <Row label="等关键帧丢弃" value={num(snapshot.diag.waitingForKeyframe)} warn={snapshot.diag.waitingForKeyframe > 0} />
      <Row label="缺解码配置 / 无画布 / 解码报错" value={`${snapshot.diag.noDecoderConfig} / ${snapshot.diag.noCanvas} / ${snapshot.diag.decodeErrors}`} warn={snapshot.diag.decodeErrors > 0} />
      <Row label="重同步次数" value={num(snapshot.decodeRecoveries)} />
      <Row label="接收帧率 / 延迟" value={`${snapshot.receivedFps.toFixed(1)} fps / ${snapshot.latencyMs === null ? "—" : `${Math.round(snapshot.latencyMs)} ms`}`} />
      <Row label="往返时间" value={snapshot.rttMs === null ? "—" : `${Math.round(snapshot.rttMs)} ms`} />
      <Row label="WebCodecs" value={snapshot.webCodecs ? "有" : "无"} />
      <Row label="最近问题" value={snapshot.diag.lastProblem ?? "无"} warn={Boolean(snapshot.diag.lastProblem)} />
    </Section>

    <Section title="④ 手机实际显示（读回屏幕像素）">
      <Row label="读取的表面" value={readback ? `${readback.surface === "canvas" ? "H.264 画布" : readback.surface === "image" ? "JPEG 图片" : "无"} ${readback.width}×${readback.height}` : "—"} />
      <Row label="显示亮度" value={readback ? (readback.brightness < 0 ? "无法读取" : `${readback.brightness.toFixed(1)}（最亮 ${readback.maxBrightness.toFixed(0)}）`) : "—"} warn={readback !== null && readback.brightness >= 0 && readback.maxBrightness < 8} />
      <Row label="读取错误" value={readback?.error ?? "无"} warn={Boolean(readback?.error)} />
      <Row label="读取时间" value={readback ? ago(readback.at) : "—"} />
    </Section>

    <Section title="⑤ 电脑端身份">
      <Row label="版本 / 系统" value={status?.identity ? `${status.identity.version} · ${status.identity.os}` : "—"} />
      <Row label="进程" value={status?.identity ? `pid ${status.identity.pid}` : "—"} />
      <Row label="程序路径" value={status?.identity?.executable ?? "—"} />
      <Row label="屏幕录制授权" value={status ? (status.permission ? "已授权" : "未授权") : "—"} warn={status !== null && !status.permission} />
    </Section>

    <Section title="⑥ 电脑端日志">
      <Log entries={(status?.events ?? []).map(event => ({ at: event.atMs, message: event.message }))} />
    </Section>

    <Section title="⑦ 手机端日志">
      <Log entries={snapshot.log} />
    </Section>

    <details className="screen-diagnostics-raw">
      <summary>完整文本（可长按选择）</summary>
      <pre>{report}</pre>
    </details>
  </div>
}

const STATE_LABELS: Record<string, string> = { idle: "未开启", connecting: "连接中", live: "运行中", failed: "失败" }

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="screen-diagnostics-section"><h3>{title}</h3><dl>{children}</dl></section>
}

function Row({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return <div className="screen-diagnostics-row" data-warn={warn || undefined}><dt>{label}</dt><dd>{value}</dd></div>
}

function Log({ entries }: { entries: { at: number; message: string }[] }) {
  if (!entries.length) return <p className="screen-hint">暂无</p>
  return <ol className="screen-diagnostics-log">
    {[...entries].reverse().map((entry, index) => <li key={`${entry.at}-${index}`}><time>{clock(entry.at)}</time><span>{entry.message}</span></li>)}
  </ol>
}

