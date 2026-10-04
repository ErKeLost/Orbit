import { useCallback, useEffect, useMemo, useState } from "react"
import { useWorkspace } from "../../lib/store"
import { Button, Input, Select } from "../UI"
import { Icon } from "../Icon"
import {
  screenChannel,
  sendScreenInput,
  supportsHardwareH264,
  type ScreenChannelSnapshot,
} from "../../lib/remote-screen"
import type { RemoteDisplay } from "../../lib/remote-protocol"
import { formatBitrate, formatBytes } from "../../lib/screen-host"
import { expandedSettings } from "../../lib/screen-pip"
import { ScreenFrame } from "./ScreenFrame"

/**
 * The enlarged view, where input is enabled.
 *
 * It is an overlay, not a panel: the conversation stays mounted underneath and
 * closing this returns to exactly the same state. Nothing here is a remote
 * desktop control surface — there is no key bar, because this product is a chat
 * session with a window onto the computer, not a VNC client.
 */
export function ScreenExpanded({ snapshot }: { snapshot: ScreenChannelSnapshot }) {
  const [draft, setDraft] = useState("")
  const [profile, setProfile] = useState<"balanced" | "sharp">("sharp")
  const [busy, setBusy] = useState(false)
  const [h264, setH264] = useState(false)

  useEffect(() => {
    void supportsHardwareH264().then(setH264)
  }, [])

  const close = useCallback(() => useWorkspace.getState().set({ screenExpanded: false }), [])

  const apply = useCallback(async (next: "balanced" | "sharp") => {
    setProfile(next)
    setBusy(true)
    try {
      const base = expandedSettings()
      // The "saver" choice halves the pixel budget; `maxWidth` is optional in
      // the protocol, so fall back to the base value rather than to `NaN`.
      await screenChannel().start(next === "sharp" ? base : { ...base, maxWidth: Math.min(base.maxWidth ?? 1000, 1000), quality: 62 })
    } finally {
      setBusy(false)
    }
  }, [])

  // Escape closes, matching every other overlay in this app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [close])

  return <div className="screen-sheet-backdrop" role="dialog" aria-modal="true" aria-label="电脑屏幕">
    <div className="screen-sheet">
      <header className="screen-sheet-bar">
        <Button className="screen-pip-action" title="收回小窗" aria-label="收回小窗" onClick={close}><Icon name="caret-down" /></Button>
        <span className="screen-sheet-title">{snapshot.display?.name ?? "电脑屏幕"}</span>
        <span className="screen-state" data-state={snapshot.state}>
          <span className="screen-state-dot" />
          {snapshot.state === "live" ? "实时" : snapshot.state === "connecting" ? "连接中" : snapshot.state === "failed" ? "已停止" : "未开始"}
        </span>
        <span className="screen-pip-spacer" />
        <Select value={profile} onChange={event => void apply(event.target.value as "balanced" | "sharp")} disabled={busy} aria-label="预览画质">
          <option value="balanced">省流</option>
          <option value="sharp">清晰</option>
        </Select>
        {h264 && <Button
          className={`screen-pip-action ${snapshot.codec === "h264" ? "selected" : ""}`}
          title={snapshot.codec === "h264" ? "已用 H.264（同画质下带宽低一个数量级）" : "强制用 H.264 试试"}
          aria-label="切换编码格式"
          onClick={() => void screenChannel().start({ ...expandedSettings(), codec: snapshot.codec === "h264" ? "jpeg" : "h264" })}
        ><Icon name={snapshot.codec === "h264" ? "film-strip" : "image-square"} /></Button>}
        <DisplayPicker
          displays={snapshot.displays}
          current={snapshot.display}
          onPick={id => void screenChannel().start({ ...expandedSettings(), displayId: id })}
        />
      </header>

      {snapshot.error && <p className="screen-error">{snapshot.error}</p>}
      {snapshot.codecNote && <p className="screen-note">{snapshot.codecNote}</p>}

      <ScreenFrame snapshot={snapshot} interactive />

      <ScreenMetrics snapshot={snapshot} />

      <form className="screen-type-row" onSubmit={event => {
        event.preventDefault()
        const value = draft
        if (!value) return
        setDraft("")
        sendScreenInput({ kind: "text", value })
      }}>
        <Input value={draft} onChange={event => setDraft(event.target.value)} placeholder="在电脑上输入…" aria-label="在电脑上输入" />
        <Button type="submit" className="screen-pip-action" aria-label="发送文本"><Icon name="arrow-up" /></Button>
      </form>

      <p className="screen-hint">点按画面即操作电脑；双指滑动为滚轮。文字会输入到电脑当前焦点处。</p>
    </div>
  </div>
}

function ScreenMetrics({ snapshot }: { snapshot: ScreenChannelSnapshot }) {
  const rows = useMemo(() => {
    const frame = snapshot.frame
    return [
      ["帧率", `${snapshot.receivedFps.toFixed(1)} fps`],
      // Only meaningful now that it is measured on the host's clock.
      ["延迟", snapshot.latencyMs === null ? "—" : `${Math.round(snapshot.latencyMs)} ms`],
      ["码率", formatBitrate(snapshot.status?.bitsPerSecond ?? 0)],
      ["单帧", formatBytes(frame?.bytes ?? 0)],
      ["分辨率", frame ? `${frame.width} × ${frame.height}` : "—"],
      ["编码", snapshot.status ? `${snapshot.status.encodeMsAvg.toFixed(1)} ms` : "—"],
      ["重同步", String(snapshot.decodeRecoveries)],
    ] as const
  }, [snapshot])
  return <dl className="screen-metrics-row">
    {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>
}

function DisplayPicker({ displays, current, onPick }: { displays: RemoteDisplay[]; current: RemoteDisplay | null; onPick: (id: number) => void }) {
  if (displays.length < 2) return null
  return <Select value={String(current?.id ?? "")} onChange={event => onPick(Number(event.target.value))} aria-label="选择显示器">
    {displays.map(display => <option key={display.id} value={display.id}>{display.name}</option>)}
  </Select>
}
