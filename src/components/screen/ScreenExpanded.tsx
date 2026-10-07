import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useWorkspace } from "../../lib/store"
import { Icon } from "../Icon"
import { Check, ChevronDown } from "../../shared/ui/icons"
import { Popover } from "../../shared/ui/Popover"
import { sendScreenInput, type ScreenChannelSnapshot } from "../../lib/remote-screen"
import type { RemoteDisplay } from "../../lib/remote-protocol"
import { formatBitrate, formatBytes } from "../../lib/screen-host"
import { useScreenPreferences } from "../../lib/screen-settings"
import { ScreenFrame } from "./ScreenFrame"

/**
 * The enlarged view, where input is enabled.
 *
 * It is an overlay, not a panel: the conversation stays mounted underneath and
 * closing this returns to exactly the same state. Configuration is deliberately
 * absent — everything lives in Settings → 屏幕 — because a control strip on top
 * of the thing you are trying to look at is how you end up not knowing what the
 * current settings are. The two exceptions are both choices about *this*
 * moment: which display to watch, and whether the numbers matter right now.
 */
export function ScreenExpanded({ snapshot }: { snapshot: ScreenChannelSnapshot }) {
  const [draft, setDraft] = useState("")
  const [statsOpen, setStatsOpen] = useState(false)
  const close = useCallback(() => useWorkspace.getState().set({ screenExpanded: false }), [])

  // Escape closes, matching every other overlay in this app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [close])

  // The glanceable line: the four numbers that describe *this* second. The
  // full grid stays behind the 统计 toggle.
  const summary = useMemo(() => {
    const frame = snapshot.frame
    return [
      `${snapshot.receivedFps.toFixed(1)} fps`,
      snapshot.latencyMs === null ? null : `${Math.round(snapshot.latencyMs)} ms`,
      snapshot.status?.bitsPerSecond ? formatBitrate(snapshot.status.bitsPerSecond) : null,
      frame ? `${frame.width}×${frame.height}` : null,
    ].filter(Boolean).join("  ·  ")
  }, [snapshot.receivedFps, snapshot.latencyMs, snapshot.status?.bitsPerSecond, snapshot.frame])

  const stateLabel = snapshot.state === "live"
    ? "实时"
    : snapshot.state === "connecting"
      ? "连接中"
      : snapshot.state === "failed"
        ? "已停止"
        : "未开始"

  return <div className="screen-sheet-backdrop" role="dialog" aria-modal="true" aria-label="电脑屏幕">
    <div className="screen-sheet">
      <header className="screen-sheet-bar">
        <button type="button" className="screen-pip-action" title="收回小窗" aria-label="收回小窗" onClick={close}>
          <Icon name="caret-down" />
        </button>
        <div className="screen-sheet-titles">
          <span className="screen-sheet-title">{snapshot.display?.name ?? "电脑屏幕"}</span>
          <span className="screen-state" data-state={snapshot.state}>
            <span className="screen-state-dot" />
            {stateLabel}
          </span>
        </div>
        <DisplayPicker
          displays={snapshot.displays}
          current={snapshot.display}
          onPick={id => useScreenPreferences.getState().set({ source: "display", displayId: id })}
        />
        <button
          type="button"
          className="screen-pip-action"
          title="屏幕设置"
          aria-label="屏幕设置"
          onClick={() => useWorkspace.getState().set({ panel: "settings", settingsPage: "screen", screenExpanded: false })}
        ><Icon name="gear-six" /></button>
      </header>

      <div className="screen-sheet-view">
        <ScreenFrame snapshot={snapshot} interactive fill />
      </div>

      <footer className="screen-dock">
        {snapshot.status?.failure ? <p className="screen-error" role="alert">{`电脑端错误：${snapshot.status.failure}`}</p> : null}
        <div className="screen-status-strip">
          <span className="screen-strip-metrics">{summary || "—"}</span>
          <button
            type="button"
            className={`screen-strip-toggle ${statsOpen ? "open" : ""}`}
            aria-expanded={statsOpen}
            title="完整统计"
            onClick={() => setStatsOpen(value => !value)}
          >
            统计 <ChevronDown strokeWidth={1.75} />
          </button>
        </div>
        {statsOpen ? <ScreenMetrics snapshot={snapshot} /> : null}
        <form className="screen-type-row" onSubmit={event => {
          event.preventDefault()
          const value = draft
          if (!value) return
          setDraft("")
          sendScreenInput({ kind: "text", value })
        }}>
          <input
            value={draft}
            onChange={event => setDraft(event.target.value)}
            placeholder="在电脑上输入…"
            aria-label="在电脑上输入"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="submit" className="screen-send" aria-label="发送文本" disabled={!draft.trim()}>
            <Icon name="arrow-up" />
          </button>
        </form>
        <p className="screen-hint">点按画面即操作电脑 · 双指滑动为滚轮 · 文字会输入到电脑当前焦点处</p>
      </footer>
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
      ["解码排队", String(snapshot.decodeQueue)],
    ] as const
  }, [snapshot])
  return <dl className="screen-metrics-row">
    {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>
}

/** MonoCode's popover menu, on the composer-model-row vocabulary. */
function DisplayPicker({ displays, current, onPick }: { displays: RemoteDisplay[]; current: RemoteDisplay | null; onPick: (id: number) => void }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  if (displays.length < 2) return null
  const dismiss = () => setOpen(false)
  return <>
    <button
      ref={trigger}
      type="button"
      className="screen-picker-trigger"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label="选择显示器"
      onClick={() => setOpen(value => !value)}
    >
      <span>{current?.name ?? "选择显示器"}</span>
      <ChevronDown strokeWidth={1.75} />
    </button>
    {open ? (
      <Popover
        anchor={trigger}
        side="bottom"
        align="end"
        width={216}
        onDismiss={dismiss}
        role="dialog"
        aria-label="选择显示器"
        className="screen-picker-menu"
      >
        <div style={{ padding: "4px 6px 6px" }}>
          <p className="screen-picker-label">画面来源</p>
          {displays.map(display => (
            <button
              key={display.id}
              type="button"
              className={`screen-picker-row ${current?.id === display.id ? "active" : ""}`}
              onClick={() => {
                dismiss()
                onPick(display.id)
              }}
            >
              <span>{display.name}</span>
              {current?.id === display.id ? <Check strokeWidth={2} /> : null}
            </button>
          ))}
        </div>
      </Popover>
    ) : null}
  </>
}
