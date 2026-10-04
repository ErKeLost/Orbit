import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { gooeyToast } from "goey-toast"
import { useWorkspace } from "../../lib/store"
import { Button, Input, Select } from "../UI"
import { Icon } from "../Icon"
import { SettingsGroup, SettingRow } from "./GeneralSettingsPanel"
import { screenChannel, sendScreenInput, supportsHardwareH264, type ScreenChannelSnapshot } from "../../lib/remote-screen"
import type { RemoteDisplay, RemoteScreenSettings } from "../../lib/remote-protocol"
import {
  formatBitrate,
  formatBytes,
  screenHostRequestPermission,
  screenHostStatus,
  screenHostStop,
  type ScreenHostStatus,
} from "../../lib/screen-host"
import "../../styles/screen-channel.css"

/**
 * Preview shapes a phone can ask for. The host clamps all of them.
 *
 * Because H.264 costs a fraction of what JPEG costs for the same legibility,
 * the "sharp" preset is affordable at full phone resolution rather than being
 * something the bandwidth governor immediately walks back.
 */
const PROFILES = {
  saver: { label: "省流", maxWidth: 960, maxFps: 6, quality: 55 },
  balanced: { label: "均衡", maxWidth: 1280, maxFps: 10, quality: 62 },
  sharp: { label: "清晰", maxWidth: 1600, maxFps: 15, quality: 75 },
} as const

const CODEC_LABELS: Record<string, string> = { h264: "H.264", jpeg: "JPEG" }

type ProfileId = keyof typeof PROFILES

const KEY_BAR: { label: string; icon?: string; key: string }[] = [
  { label: "esc", key: "escape" },
  { label: "tab", key: "tab" },
  { label: "", icon: "arrow-up", key: "arrowup" },
  { label: "", icon: "arrow-down", key: "arrowdown" },
  { label: "", icon: "arrow-left", key: "arrowleft" },
  { label: "", icon: "arrow-right", key: "arrowright" },
  { label: "⌘ space", key: "meta+space" },
  { label: "⌘Z", key: "meta+z" },
]

function profileSettings(profile: ProfileId, codec?: "h264" | "jpeg"): RemoteScreenSettings {
  const preset = PROFILES[profile]
  // Never ask for more pixels than this screen can actually show: a phone
  // panel is the limiting factor, not the desktop.
  const deviceWidth = Math.round(window.innerWidth * Math.min(window.devicePixelRatio || 1, 2))
  return {
    maxWidth: Math.max(640, Math.min(preset.maxWidth, deviceWidth || preset.maxWidth)),
    maxFps: preset.maxFps,
    quality: preset.quality,
    ...(codec ? { codec } : {}),
  }
}

export function ScreenPanel({ visible = true }: { visible?: boolean }) {
  const mobile = useWorkspace(state => state.runtimeTarget === "mobile")
  const online = useWorkspace(state => state.connection === "online")
  return mobile ? <ScreenViewer online={online} visible={visible} /> : <ScreenChannelStatus visible={visible} />;
}

// ── Phone: the live preview ──────────────────────────────────────────

function ScreenViewer({ online, visible }: { online: boolean; visible: boolean }) {
  const [snapshot, setSnapshot] = useState<ScreenChannelSnapshot>(() => screenChannel().current)
  const [profile, setProfile] = useState<ProfileId>("balanced")
  const [busy, setBusy] = useState(false)
  const [button, setButton] = useState<"left" | "right">("left")
  const [draft, setDraft] = useState("")
  const [keyboard, setKeyboard] = useState(true)
  const [metrics, setMetrics] = useState(false)
  const [h264, setH264] = useState(false)
  /** Explicit codec choice, or `null` to let the channel pick the best one. */
  const [codec, setCodec] = useState<"h264" | "jpeg" | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => screenChannel().subscribe(setSnapshot), [])
  // Asked once per process and cached inside the channel; the answer decides
  // both the default codec and whether the toggle is offered at all.
  useEffect(() => {
    void supportsHardwareH264().then(setH264)
  }, [])
  // The channel draws into the canvas and owns the `VideoFrame` lifecycle, so
  // the element is handed over rather than rendered into from here.
  useEffect(() => {
    screenChannel().attachCanvas(canvas.current)
    return () => screenChannel().attachCanvas(null)
  }, [snapshot.codec])
  // Drawing is skipped while the tab is hidden — decoding has to continue, or
  // the H.264 reference chain would break, but compositing a canvas nobody can
  // see is pure battery.
  useEffect(() => screenChannel().setRendering(visible), [visible])

  /**
   * (Re)start the preview. Called on mount, on a profile change, and when the
   * viewer switches monitors; the host treats each call as the current shape
   * and restarts capture only when it actually differs.
   */
  const apply = useCallback(async (
    next: ProfileId,
    options: { displayId?: number; codec?: "h264" | "jpeg" | null } = {},
  ) => {
    setProfile(next)
    if (options.codec !== undefined) setCodec(options.codec)
    setBusy(true)
    try {
      const settings = profileSettings(next, options.codec ?? undefined)
      await screenChannel().start({
        ...settings,
        ...(options.displayId === undefined ? {} : { displayId: options.displayId }),
      })
    } catch (error) {
      gooeyToast.error("屏幕预览未启动", { description: message(error), showTimestamp: false })
    } finally {
      setBusy(false)
    }
  }, [])

  // Start on mount and release the subscription on unmount. The connection
  // itself stays open, so coming back to the tab is instant; the desktop
  // keeps the capture stream alive for its own idle grace period.
  //
  // The opening profile is read through a ref so the effect depends only on
  // `online`: a profile change goes through `apply`, and re-running this
  // effect would tear the subscription down and rebuild it for nothing.
  //
  // No codec is requested here: the channel probes WebCodecs and picks H.264
  // when it can, which is also why this effect does not wait for that probe.
  //
  // The preview starts the *first* time this panel is on screen and then keeps
  // running, so switching to the conversation and back is instant instead of a
  // capture restart. It is torn down when the workspace itself goes away.
  const [openingProfile] = useState(profile)
  const started = useRef(false)
  useEffect(() => {
    if (!online || !visible || started.current) return
    started.current = true
    void screenChannel().start(profileSettings(openingProfile)).catch(error => {
      started.current = false
      gooeyToast.error("屏幕预览未启动", { description: message(error), showTimestamp: false })
    })
  }, [online, visible, openingProfile])
  useEffect(() => () => {
    void screenChannel().stop()
  }, [])

  const frame = snapshot.frame
  const aspect = frame ? frame.width / frame.height : 16 / 9

  return <div className="screen-viewer">
    <header className="screen-toolbar">
      <span className="screen-state" data-state={snapshot.state}>
        <span className="screen-state-dot" />
        {snapshot.state === "live" ? "实时" : snapshot.state === "connecting" ? "连接中" : snapshot.state === "failed" ? "已停止" : "未开始"}
      </span>
      {frame && <span className="screen-meta">{frame.width} × {frame.height}</span>}
      <span className="screen-meta screen-codec" data-codec={snapshot.codec}>{CODEC_LABELS[snapshot.codec] ?? snapshot.codec}</span>
      <span className="screen-spacer" />
      <Select value={profile} onChange={event => void apply(event.target.value as ProfileId, { codec })} disabled={busy} aria-label="预览画质">
        {(Object.keys(PROFILES) as ProfileId[]).map(id => <option key={id} value={id}>{PROFILES[id].label}</option>)}
      </Select>
      {h264 && <Button
        className={`icon-button ${snapshot.codec === "h264" ? "selected" : ""}`}
        title={snapshot.codec === "h264" ? "切换到 JPEG（画质更低、兼容性更好）" : "切换到 H.264（同画质下带宽低一个数量级）"}
        onClick={() => void apply(profile, { codec: snapshot.codec === "h264" ? "jpeg" : "h264" })}
        aria-label="切换编码格式"
      ><Icon name={snapshot.codec === "h264" ? "film-strip" : "image-square"} /></Button>}
      <Button className={`icon-button ${metrics ? "selected" : ""}`} onClick={() => setMetrics(value => !value)} aria-label="显示统计">
        <Icon name="chart-bar" />
      </Button>
    </header>

    {snapshot.error && <p className="screen-error">{snapshot.error}</p>}

    <div className="screen-stage" style={{ aspectRatio: aspect }}>
      <ScreenSurface aspect={aspect} button={button} enabled={snapshot.state === "live"} />
      {snapshot.codec === "h264"
        ? <canvas className="screen-frame" ref={canvas} role="img" aria-label="桌面屏幕预览" />
        : snapshot.frameUrl
          ? <img className="screen-frame" src={snapshot.frameUrl} alt="桌面屏幕预览" draggable={false} />
          : <div className="screen-placeholder">
              <Icon name="play-circle" />
              <p>{snapshot.state === "failed" ? "预览已停止" : "正在等待桌面画面…"}</p>
            </div>}
      {metrics && <dl className="screen-metrics">
        <div><dt>帧率</dt><dd>{snapshot.receivedFps.toFixed(1)} fps</dd></div>
        <div><dt>延迟</dt><dd>{snapshot.latencyMs === null ? "—" : `${Math.round(snapshot.latencyMs)} ms`}</dd></div>
        <div><dt>码率</dt><dd>{formatBitrate(snapshot.status?.bitsPerSecond ?? 0)}</dd></div>
        <div><dt>单帧</dt><dd>{formatBytes(frame?.bytes ?? 0)}</dd></div>
        <div><dt>序号</dt><dd>{frame?.seq ?? 0}</dd></div>
        <div><dt>编码</dt><dd>{snapshot.status ? `${snapshot.status.encodeMsAvg.toFixed(1)} ms` : "—"}</dd></div>
        {snapshot.decodeRecoveries > 0 && <div><dt>重同步</dt><dd>{snapshot.decodeRecoveries}</dd></div>}
      </dl>}
    </div>

    <div className="screen-controls">
      <Button className={`screen-key ${button === "right" ? "selected" : ""}`} onClick={() => setButton(value => value === "left" ? "right" : "left")} title={button === "left" ? "当前为左键，点击切换" : "当前为右键，点击切换"}>
        {button === "left" ? "左键" : "右键"}
      </Button>
      <Button className={`icon-button ${keyboard ? "selected" : ""}`} onClick={() => setKeyboard(value => !value)} aria-label="显示按键栏">
        <Icon name="keyboard" />
      </Button>
      <DisplayPicker displays={snapshot.displays} current={snapshot.display} onPick={id => void apply(profile, { displayId: id, codec })} />
      <span className="screen-spacer" />
      <Button className="icon-button" onClick={() => void screenChannel().stop()} aria-label="停止预览"><Icon name="stop-fill" /></Button>
    </div>

    {keyboard && <div className="screen-key-row">
      {KEY_BAR.map(entry => <Button key={entry.key} className="screen-key" onClick={() => sendScreenInput({ kind: "key", key: entry.key })} aria-label={entry.label || entry.key}>
        {entry.icon ? <Icon name={entry.icon} /> : entry.label}
      </Button>)}
    </div>}

    <form className="screen-type-row" onSubmit={event => {
      event.preventDefault()
      const value = draft
      if (!value) return
      setDraft("")
      sendScreenInput({ kind: "text", value })
    }}>
      <Input value={draft} onChange={event => setDraft(event.target.value)} placeholder="在 Mac 上输入…" aria-label="在 Mac 上输入" />
      <Button type="submit" className="icon-button" aria-label="发送文本"><Icon name="arrow-up" /></Button>
    </form>
  </div>
}

/**
 * The touch surface.
 *
 * Coordinates are normalized against the *rendered image box*, not the outer
 * container: the preview uses `object-fit: contain`, so a wide desktop on a
 * tall phone has real letterboxing that would otherwise offset every click.
 *
 * Two fingers switch to scrolling, and the in-flight single-pointer gesture is
 * cancelled with a `pointer up` first, so a two-finger scroll never leaves a
 * phantom drag behind on the desktop.
 */
function ScreenSurface({ aspect, button, enabled }: { aspect: number; button: "left" | "right"; enabled: boolean }) {
  const surface = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const scrolling = useRef(false)
  const pending = useRef<{ x: number; y: number } | null>(null)
  const raf = useRef<number | null>(null)

  const normalize = useCallback((clientX: number, clientY: number) => {
    const element = surface.current
    if (!element) return null
    const rect = element.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    const containerAspect = rect.width / rect.height
    let width = rect.width
    let height = rect.height
    let offsetX = 0
    let offsetY = 0
    if (aspect > containerAspect) {
      height = rect.width / aspect
      offsetY = (rect.height - height) / 2
    } else {
      width = rect.height * aspect
      offsetX = (rect.width - width) / 2
    }
    return {
      x: clamp01((clientX - rect.left - offsetX) / width),
      y: clamp01((clientY - rect.top - offsetY) / height),
    }
  }, [aspect])

  const flush = useCallback(() => {
    raf.current = null
    const point = pending.current
    pending.current = null
    if (!point) return
    sendScreenInput({ kind: "pointer", phase: "move", x: point.x, y: point.y })
  }, [])

  const schedule = useCallback((point: { x: number; y: number }) => {
    pending.current = point
    // One move per animation frame is the most the eye can use, and it keeps a
    // fast drag from flooding the socket.
    if (raf.current === null) raf.current = requestAnimationFrame(flush)
  }, [flush])

  useEffect(() => () => { if (raf.current !== null) cancelAnimationFrame(raf.current) }, [])

  if (!enabled) return <div className="screen-surface" ref={surface} aria-hidden />

  return <div
    className="screen-surface"
    ref={surface}
    onPointerDown={event => {
      const point = normalize(event.clientX, event.clientY)
      if (!point) return
      pointers.current.set(event.pointerId, point)
      if (pointers.current.size > 1) {
        if (!scrolling.current) {
          scrolling.current = true
          // Cancel the gesture that a first finger already started.
          sendScreenInput({ kind: "pointer", phase: "up", x: point.x, y: point.y })
        }
        return
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      sendScreenInput({ kind: "pointer", phase: "down", x: point.x, y: point.y, button })
    }}
    onPointerMove={event => {
      const point = normalize(event.clientX, event.clientY)
      if (!point) return
      const previous = pointers.current.get(event.pointerId)
      pointers.current.set(event.pointerId, point)
      if (scrolling.current) {
        if (previous && pointers.current.size > 1) {
          // Vertical distance between the two fingers drives the wheel.
          sendScreenInput({ kind: "scroll", x: point.x, y: point.y, dx: 0, dy: Math.round((previous.y - point.y) * 24) })
        }
        return
      }
      schedule(point)
    }}
    onPointerUp={event => {
      const point = normalize(event.clientX, event.clientY) ?? pointers.current.get(event.pointerId)
      pointers.current.delete(event.pointerId)
      if (scrolling.current) {
        if (pointers.current.size === 0) scrolling.current = false
        return
      }
      if (!point) return
      sendScreenInput({ kind: "pointer", phase: "up", x: point.x, y: point.y, button })
    }}
    onPointerCancel={event => {
      pointers.current.delete(event.pointerId)
      if (pointers.current.size === 0) scrolling.current = false
    }}
    onWheel={event => {
      const point = normalize(event.clientX, event.clientY)
      if (!point) return
      sendScreenInput({ kind: "scroll", x: point.x, y: point.y, dx: Math.round(event.deltaX / 12), dy: Math.round(event.deltaY / 12) })
    }}
    role="application"
    aria-label="桌面触控区域"
  />
}

function DisplayPicker({ displays, current, onPick }: { displays: RemoteDisplay[]; current: RemoteDisplay | null; onPick: (id: number) => void }) {
  if (displays.length < 2) return null
  return <Select value={String(current?.id ?? "")} onChange={event => onPick(Number(event.target.value))} aria-label="选择显示器">
    {displays.map(display => <option key={display.id} value={display.id}>{display.name}</option>)}
  </Select>
}

// ── Desktop: channel status ──────────────────────────────────────────

function ScreenChannelStatus({ visible }: { visible: boolean }) {
  const [status, setStatus] = useState<ScreenHostStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const desktop = useWorkspace(state => state.runtimeTarget === "desktop")
  const online = useWorkspace(state => state.connection === "online")

  // The phone drives capture and this page only observes, so the counters are
  // polled rather than pushed — there is no host-initiated event for "the
  // phone started watching", and inventing one for a settings page is not
  // worth a protocol addition.
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!desktop || !visible) return
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
    const timer = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [desktop, visible, revision])
  const reload = useCallback(() => setRevision(value => value + 1), [])

  const displays = useMemo(() => status?.displays ?? [], [status])

  if (!desktop) return <div className="screen-viewer">
    <div className="screen-placeholder screen-placeholder-block">
      <Icon name="desktop" />
      <p>屏幕预览由手机端发起：打开 Orbit 手机端，进入「屏幕」即可。</p>
    </div>
  </div>

  return <div className="screen-viewer screen-status-panel">
    <div className="panel-heading">
      <div><h1><Icon name="desktop" />屏幕通道</h1></div>
    </div>
    {error && <p className="screen-error">{error}</p>}
    <SettingsGroup title="权限" icon="shield-check" description="macOS 的「屏幕录制」与辅助功能是两个独立授权，屏幕预览需要前者。">
      <SettingRow title="屏幕录制" description={status?.permission ? "已授权，手机端可以请求预览。" : "未授权。授权后需要重启 Orbit。"}>
        <span className="remote-host-status" aria-live="polite">
          <span className="remote-host-status-dot" data-online={Boolean(status?.permission)} />
          {status?.permission ? "已授权" : "未授权"}
        </span>
      </SettingRow>
      <SettingRow title="请求授权" description="弹出系统授权对话框；授权完成后回到这里刷新即可。">
        <Button disabled={busy} onClick={async () => {
          setBusy(true)
          try { await screenHostRequestPermission() } catch (cause) { setError(message(cause)) }
          finally { setBusy(false); void reload() }
        }}>请求授权</Button>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup title="状态" icon="chart-bar" description="屏幕通道只在手机端主动请求时运行，空闲 20 秒后自动释放采集。">
      <SettingRow title="采集" description={`${status?.display?.name ?? "未选择显示器"} · ${status?.width ?? 0} × ${status?.height ?? 0}`}>
        <span className="remote-host-status" aria-live="polite">
          <span className="remote-host-status-dot" data-online={Boolean(status?.running)} />
          {status?.running ? "运行中" : "空闲"}
        </span>
      </SettingRow>
      <SettingRow title="观看端" description="当前订阅屏幕通道的手机连接数。">
        <span className="screen-stat">{status?.subscribers ?? 0}</span>
      </SettingRow>
      <SettingRow title="编码格式" description="H.264 由 VideoToolbox 硬件编码，静止画面只花几百字节；JPEG 是无解码器要求时的兜底。">
        <span className="screen-stat">{CODEC_LABELS[status?.codec ?? ""] ?? status?.codec ?? "—"}</span>
      </SettingRow>
      <SettingRow title="实际帧率 / 上限" description="实际值低于上限时说明画面基本静止，或带宽策略已降档。">
        <span className="screen-stat">{(status?.effectiveFps ?? 0).toFixed(1)} / {status?.fps ?? 0} fps</span>
      </SettingRow>
      <SettingRow title="码率" description="当前每秒发送的预览数据量，由带宽调节器维持在预算内。">
        <span className="screen-stat">{formatBitrate(status?.bitsPerSecond ?? 0)}</span>
      </SettingRow>
      <SettingRow title="编码耗时" description="单帧 JPEG 编码的平均与峰值耗时。">
        <span className="screen-stat">{(status?.encodeMsAvg ?? 0).toFixed(1)} / {(status?.encodeMsMax ?? 0).toFixed(1)} ms</span>
      </SettingRow>
      <SettingRow title="已发送 / 跳过" description="跳过的帧包括画面未变化的帧和被码率策略丢弃的帧。">
        <span className="screen-stat">{status?.published ?? 0} / {status?.dropped ?? 0}</span>
      </SettingRow>
      {status?.failure && <SettingRow title="故障" description={status.failure}><span className="screen-stat">注意</span></SettingRow>}
      <SettingRow title="立即停止" description="断开所有观看端并释放采集会话。">
        <Button disabled={!status?.running} onClick={async () => {
          try { setStatus(await screenHostStop()) } catch (cause) { setError(message(cause)) }
        }}>停止采集</Button>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup title="显示器" icon="desktop" description="手机端可以在这里列出的显示器之间切换。">
      {displays.length === 0
        ? <SettingRow title="未检测到显示器" description={status?.permission ? "授予屏幕录制权限后重新检查。" : "需要先授予屏幕录制权限。"}>
            <Button onClick={() => void screenHostStop().then(setStatus).catch(cause => setError(message(cause))).finally(reload)}>重新检查</Button>
          </SettingRow>
        : displays.map(display => <SettingRow key={display.id} title={display.name} description={`${Math.round(display.logicalWidth)} × ${Math.round(display.logicalHeight)} 点 · ${display.pixelWidth} × ${display.pixelHeight} 像素 · ${display.scale.toFixed(1)}x`}>
            <span className="screen-stat">{display.primary ? "主显示器" : `#${display.id}`}</span>
          </SettingRow>)}
    </SettingsGroup>
    {online && <p className="screen-hint">提示：屏幕画面走独立连接，不会和对话流争抢带宽；手机端拿不到桌面的文件和终端，预览只是画面。</p>}
  </div>
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default ScreenPanel
