import { useCallback, useEffect, useState } from "react"
import { useWorkspace } from "../../lib/store"
import { Button } from "../UI"
import { Icon } from "../Icon"
import { SettingsGroup, SettingRow } from "./GeneralSettingsPanel"
import {
  formatBitrate,
  screenHostRequestPermission,
  screenHostStatus,
  screenHostStop,
  type ScreenHostStatus,
} from "../../lib/screen-host"
import "../../styles/screen-channel.css"

const CODEC_LABELS: Record<string, string> = { h264: "H.264", jpeg: "JPEG" }

/**
 * Desktop-only: the host side of the screen channel.
 *
 * On a phone the screen is the floating window (`ScreenOverlay`) — a thing you
 * watch and occasionally enlarge, not a destination. This page is the opposite:
 * the machine that captures, and therefore the only place that can answer
 * "why is there no picture". Permission, whether capture is running, which
 * codec, and what it is actually costing are all here rather than in a log.
 */
export function ScreenPanel() {
  const desktop = useWorkspace(state => state.runtimeTarget === "desktop")
  const [status, setStatus] = useState<ScreenHostStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision(value => value + 1), [])

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    const tick = () => {
      screenHostStatus()
        .then(next => {
          if (cancelled) return
          setStatus(next)
          setError(null)
        })
        .catch(cause => {
          if (!cancelled) setError(message(cause))
        })
    }
    tick()
    // The phone starts capture, so this page cannot be event-driven: nothing on
    // the host initiates "a phone began watching".
    const timer = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [desktop, revision])

  if (!desktop) return <div className="screen-page">
    <div className="screen-placeholder screen-placeholder-block">
      <Icon name="desktop" />
      <p>屏幕是手机端的浮动小窗，在这台电脑上无需配置。</p>
    </div>
  </div>

  const displays = status?.displays ?? []

  return <div className="screen-page">
    <div className="panel-heading">
      <div><h1><Icon name="desktop" />屏幕通道</h1></div>
    </div>
    {error && <p className="screen-error">{error}</p>}

    <SettingsGroup title="权限" icon="shield-check" description="macOS 的「屏幕录制」与辅助功能是两个独立授权，屏幕预览需要前者。授权后必须完全退出 Orbit 再打开。">
      <SettingRow title="屏幕录制" description={status?.permission ? "当前进程已获授权。" : "未授权：采集不会启动，手机端会收到明确提示。"}>
        <span className="remote-host-status" aria-live="polite">
          <span className="remote-host-status-dot" data-online={Boolean(status?.permission)} />
          {status?.permission ? "已授权" : "未授权"}
        </span>
      </SettingRow>
      <SettingRow
        title="请求授权"
        description="弹出系统授权框。Orbit 是 ad-hoc 签名，每次更新后系统会把它当作新应用，需要重新授权一次。"
      >
        <Button disabled={busy} onClick={async () => {
          setBusy(true)
          try {
            await screenHostRequestPermission()
          } catch (cause) {
            setError(message(cause))
          } finally {
            setBusy(false)
            reload()
          }
        }}>请求授权</Button>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup title="状态" icon="chart-bar" description="只在手机端打开屏幕小窗时运行；最后一个观看端离开 20 秒后自动释放采集。">
      <SettingRow title="采集" description={`${status?.display?.name ?? "未选择显示器"} · ${status?.width ?? 0} × ${status?.height ?? 0}`}>
        <span className="remote-host-status" aria-live="polite">
          <span className="remote-host-status-dot" data-online={Boolean(status?.running)} />
          {status?.running ? "运行中" : "空闲"}
        </span>
      </SettingRow>
      <SettingRow title="编码格式" description="H.264 由 VideoToolbox 硬件编码，静止画面只花几百字节；JPEG 是手机端没有 WebCodecs 时的兜底。">
        <span className="screen-stat">{CODEC_LABELS[status?.codec ?? ""] ?? status?.codec ?? "—"}</span>
      </SettingRow>
      <SettingRow title="观看端" description="当前订阅屏幕通道的连接数。">
        <span className="screen-stat">{status?.subscribers ?? 0}</span>
      </SettingRow>
      <SettingRow title="实际帧率 / 上限" description="明显低于上限时，多半是画面基本静止，或带宽策略已降档。">
        <span className="screen-stat">{(status?.effectiveFps ?? 0).toFixed(1)} / {status?.fps ?? 0} fps</span>
      </SettingRow>
      <SettingRow title="码率" description="每秒发出的预览数据量，由带宽调节器维持在预算内。">
        <span className="screen-stat">{formatBitrate(status?.bitsPerSecond ?? 0)}</span>
      </SettingRow>
      <SettingRow title="编码耗时" description="单帧编码的平均与峰值耗时。">
        <span className="screen-stat">{(status?.encodeMsAvg ?? 0).toFixed(1)} / {(status?.encodeMsMax ?? 0).toFixed(1)} ms</span>
      </SettingRow>
      <SettingRow title="已发送 / 跳过" description="跳过包含画面未变化的帧、带宽丢弃的帧，以及超过 relay 单帧上限的帧。">
        <span className="screen-stat">{status?.published ?? 0} / {status?.dropped ?? 0}</span>
      </SettingRow>
      {status?.failure && <SettingRow title="故障" description={status.failure}><span className="screen-stat">注意</span></SettingRow>}
      <SettingRow title="立即停止" description="断开所有观看端并释放采集会话。">
        <Button disabled={!status?.running} onClick={() => void screenHostStop().then(setStatus).catch(cause => setError(message(cause)))}>停止采集</Button>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup title="显示器" icon="desktop" description="手机端可以在这些显示器之间切换。">
      {displays.length === 0
        ? <SettingRow title="未检测到显示器" description={status?.permission ? "重新检查一次。" : "需要先授予屏幕录制权限。"}>
            <Button onClick={reload}>重新检查</Button>
          </SettingRow>
        : displays.map(display => <SettingRow
            key={display.id}
            title={display.name}
            description={`${Math.round(display.logicalWidth)} × ${Math.round(display.logicalHeight)} 点 · ${display.pixelWidth} × ${display.pixelHeight} 像素 · ${display.scale.toFixed(1)}x`}
          >
            <span className="screen-stat">{display.primary ? "主显示器" : `#${display.id}`}</span>
          </SettingRow>)}
    </SettingsGroup>
  </div>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default ScreenPanel
