import { useEffect, useState } from "react"
import { useWorkspace } from "../../lib/store"
import { Button, Select, Switch } from "../UI"
import { Icon } from "../Icon"
import { SettingsGroup, SettingRow } from "./GeneralSettingsPanel"
import {
  useScreenPreferences,
  type ScreenCodecChoice,
  measurePanelFps,
  panelFps,
  type ScreenFps,
  type ScreenQuality,
  type ScreenSource,
} from "../../lib/screen-settings"
import { hasWebCodecs, supportsHardwareH264 } from "../../lib/remote-screen"
import { ScreenDiagnostics } from "../screen/ScreenDiagnostics"
import {
  formatBitrate,
  onScreenHostStatus,
  screenHostRequestPermission,
  screenHostStatus,
  screenHostStop,
  type ScreenHostStatus,
} from "../../lib/screen-host"
import "../../styles/screen-channel.css"

const CODEC_LABELS: Record<string, string> = { h264: "H.264", jpeg: "JPEG" }

/**
 * Every screen setting, in one place.
 *
 * The floating window shows and operates the computer; it deliberately holds no
 * configuration beyond its own size, because scattered controls mean nobody
 * knows what the current state is. This page is the single answer to "how is
 * the preview configured", on both the phone and the computer.
 */
export function ScreenSettingsPanel() {
  const mobile = useWorkspace(state => state.runtimeTarget === "mobile")
  const online = useWorkspace(state => state.connection === "online")
  const preferences = useScreenPreferences()

  return <div className="screen-page">
    <div className="panel-heading">
      <div><h1><Icon name="desktop" />屏幕</h1></div>
    </div>

    {mobile && <SettingsGroup title="诊断" icon="bug" description="从电脑采集到手机显示，每一段一个数字，外加两端的日志。黑屏时按「复制全部诊断」，把文字发过来即可。">
      <ScreenDiagnostics />
    </SettingsGroup>}

    <SettingsGroup title="画面来源" icon="desktop" description="跟随当前应用时，小窗显示的是正在被操作的那个窗口；它有 computer use，操作哪个应用就会把哪个应用带到前台。">
      <SettingRow title="来源" description={preferences.source === "app" ? "跟随当前应用窗口（推荐）" : "整个显示器画面"}>
        <Select
          value={preferences.source}
          onChange={event => preferences.set({ source: event.target.value as ScreenSource })}
          aria-label="画面来源"
        >
          <option value="app">跟随当前应用</option>
          <option value="display">整个屏幕</option>
        </Select>
      </SettingRow>
      <SettingRow title="显示光标" description="跟随应用窗口时光标不在窗口内容里，此开关只在整屏模式下有意义。">
        <Switch checked={preferences.showCursor} onChange={checked => preferences.set({ showCursor: checked })} aria-label="显示光标" />
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup title="画质与帧率" icon="sliders-horizontal" description="默认全部按上限请求：手机面板能显示的像素、屏幕刷新率、画质 90。实际能达到多少由带宽调节器实时测定，超预算时按超出倍数成比例降档，低于预算时逐级升回请求上限">
      <PanelFpsProbe />
      <SettingRow title="档位" description={preferences.quality === "max" ? "拉满：手机面板同等像素、画质 90、帧率跟随屏幕" : preferences.quality === "balanced" ? "均衡：约 3/4 像素、画质 72、≤30 fps" : "省流：约一半像素、画质 55、≤15 fps"}>
        <Select value={preferences.quality} onChange={event => preferences.set({ quality: event.target.value as ScreenQuality })} aria-label="画质档位">
          <option value="max">拉满（默认）</option>
          <option value="balanced">均衡</option>
          <option value="saver">省流</option>
        </Select>
      </SettingRow>
      <SettingRow
        title="帧率"
        description={preferences.fps === "panel"
          ? `跟随屏幕刷新率 —— 本机实测 ${panelFps()} Hz，超出刷新率的帧只会被显示管线丢掉`
          : `固定 ${preferences.fps} fps${preferences.fps > panelFps() ? `；本机屏幕只有 ${panelFps()} Hz，高于它的帧看不到` : ""}`}
      >
        <Select value={String(preferences.fps)} onChange={event => {
          const value = event.target.value
          preferences.set({ fps: value === "panel" ? "panel" : (Number(value) as ScreenFps) })
        }} aria-label="帧率">
          <option value="panel">跟随屏幕（默认）</option>
          <option value="120">120 fps</option>
          <option value="90">90 fps</option>
          <option value="60">60 fps</option>
          <option value="30">30 fps</option>
        </Select>
      </SettingRow>
      <SettingRow title="编码格式" description="H.264 由电脑硬件编码，同画质下带宽低一个数量级，是能同时做到高帧率和高清晰的前提；JPEG 是无解码器时的兜底。">
        <Select value={preferences.codec} onChange={event => preferences.set({ codec: event.target.value as ScreenCodecChoice })} aria-label="编码格式">
          <option value="auto">自动（优先 H.264）</option>
          <option value="h264">强制 H.264</option>
          <option value="jpeg">强制 JPEG</option>
        </Select>
      </SettingRow>
      <CodecDiagnostic />
    </SettingsGroup>

    <SettingsGroup title="电脑端" icon="shield-check" description="屏幕录制与辅助功能是两个独立授权；授权后必须完全退出 Orbit 再打开。Orbit 是 ad-hoc 签名，每次更新后系统都会把它当作新应用，需要重新授权一次。">
      {mobile
        ? <SettingRow title="电脑连接" description="预览由电脑采集，手机只负责显示与操作。">
            <span className="remote-host-status" aria-live="polite">
              <span className="remote-host-status-dot" data-online={online} />
              {online ? "已连接电脑" : "未连接电脑"}
            </span>
          </SettingRow>
        : <DesktopStatus />}
    </SettingsGroup>
  </div>
}

/** Measures the refresh rate once, so the numbers above are real. */
function PanelFpsProbe() {
  const [, setRevision] = useState(0)
  useEffect(() => {
    let cancelled = false
    void measurePanelFps().then(() => {
      if (!cancelled) setRevision(value => value + 1)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return null
}

/** What this device can actually decode, reported before it is needed. */
function CodecDiagnostic() {
  const [h264, setH264] = useState<boolean | null>(null)
  useEffect(() => {
    void supportsHardwareH264().then(setH264)
  }, [])
  const webCodecs = hasWebCodecs()
  const text = !webCodecs
    ? "此设备的 WebView 没有 WebCodecs，只能使用 JPEG。"
    : h264 === null
      ? "正在检测 H.264 解码能力…"
      : h264
        ? "此设备可以解码 H.264，预览会自动使用它。"
        : "此设备报告无法解码 H.264，将使用 JPEG（带宽明显更高）。"
  return <SettingRow title="本机解码能力" description={text}>
    <span className="screen-stat">{webCodecs ? (h264 === null ? "检测中" : h264 ? "H.264" : "仅 JPEG") : "无 WebCodecs"}</span>
  </SettingRow>
}

/** The host side: permission, whether capture runs, and what it costs. */
function DesktopStatus() {
  const [status, setStatus] = useState<ScreenHostStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const reload = () => setRevision(value => value + 1)

  useEffect(() => {
    let cancelled = false
    // One fetch for the facts that only change when the user changes them (the
    // display list, the permission state), then events for everything that
    // moves while capture runs.
    const load = () => {
      void screenHostStatus()
        .then(next => {
          if (!cancelled) {
            setStatus(next)
            setError(null)
          }
        })
        .catch(cause => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
        })
    }
    load()
    const stopListening = onScreenHostStatus(next => {
      if (cancelled) return
      // A stopped pipeline reports nothing rather than a stale frame count, so
      // re-read the summary instead of clearing the display list.
      if (next === null) load()
      else setStatus(current => ({ ...next, displays: next.displays.length ? next.displays : (current?.displays ?? []) }))
    })
    return () => {
      cancelled = true
      void stopListening.then(unlisten => unlisten())
    }
  }, [revision])

  const displays = status?.displays ?? []

  return <>
    {error && <p className="screen-error">{error}</p>}
    <SettingRow title="屏幕录制授权" description={status?.permission ? "当前进程已获授权。" : "未授权：采集不会启动，手机会收到明确提示。"}>
      <span className="remote-host-status" aria-live="polite">
        <span className="remote-host-status-dot" data-online={Boolean(status?.permission)} />
        {status?.permission ? "已授权" : "未授权"}
      </span>
    </SettingRow>
    <SettingRow title="请求授权" description="弹出系统授权框；授权后回到这里刷新。">
      <Button disabled={busy} onClick={async () => {
        setBusy(true)
        try {
          await screenHostRequestPermission()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
          reload()
        }
      }}>请求授权</Button>
    </SettingRow>
    <SettingRow title="采集" description={`${status?.display?.name ?? "未选择画面"} · ${status?.width ?? 0} × ${status?.height ?? 0}`}>
      <span className="remote-host-status" aria-live="polite">
        <span className="remote-host-status-dot" data-online={Boolean(status?.running)} />
        {status?.running ? "运行中" : "空闲"}
      </span>
    </SettingRow>
    <SettingRow title="实际参数" description="编码格式、实际帧率 / 上限、码率、单帧编码耗时。">
      <span className="screen-stat">
        {CODEC_LABELS[status?.codec ?? ""] ?? status?.codec ?? "—"} · {(status?.effectiveFps ?? 0).toFixed(1)}/{status?.fps ?? 0} fps · {formatBitrate(status?.bitsPerSecond ?? 0)} · {(status?.encodeMsAvg ?? 0).toFixed(1)}ms
      </span>
    </SettingRow>
    <SettingRow title="已发送 / 跳过" description="跳过包含画面未变化的帧、带宽丢弃的帧，以及超过 relay 单帧上限的帧。">
      <span className="screen-stat">{status?.published ?? 0} / {status?.dropped ?? 0}</span>
    </SettingRow>
    {status?.failure && <SettingRow title="故障" description={status.failure}><span className="screen-stat">注意</span></SettingRow>}
    <SettingRow title="立即停止" description="断开所有观看端并释放采集会话（下次打开小窗会自动重启）。">
      <Button disabled={!status?.running} onClick={() => void screenHostStop().then(setStatus)}>停止采集</Button>
    </SettingRow>
    <SettingRow title="可捕获的显示器" description={displays.length ? displays.map(display => display.name).join(" · ") : status?.permission ? "未检测到" : "需要先授予屏幕录制权限"}>
      <Button onClick={reload}>重新检查</Button>
    </SettingRow>
  </>
}

export default ScreenSettingsPanel
