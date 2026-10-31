import { useCallback, useEffect, useRef, useState } from "react"
import { AppWindow, ArrowLeft, ArrowRight, Globe, RefreshCw, Settings, X } from "../../shared/ui/icons"
import { reportBrowserFailure, normalizeAddress } from "../../lib/browser"
import {
  browserViewActivate,
  browserViewGo,
  browserViewPage,
  browserViewReload,
  browserViewStop,
  type ViewRect,
} from "../../lib/browser-view"
import { claimBrowserSurface } from "../../lib/browser-surface"
import { useShell } from "../shell/shellStore"
import { BrowserImportPrompt } from "./BrowserImportPrompt"
import { useBrowserImportStatus } from "../../lib/browser-import"
import "../../styles/browser-channel.css"

/**
 * One browser tab's content: the address bar plus the rectangle the OS view is
 * placed into.
 *
 * The panel **is** the browser — the page is drawn by a real web view that the
 * OS composites into this window (`browser_view.rs`), so nothing is streamed,
 * encoded or scaled, and scrolling, selection, IME and the mouse are native.
 *
 * The tab entry lives in the shell (`BrowserTabInfo`): a page belongs to the
 * window, so it survives the pane it was opened from, the workspace tab that was
 * in front and a switch to a full-page surface. This component only owns the
 * page.
 */
export function BrowserTab({ path, url, title, active = true, agent = false }: { path: string; url: string; title?: string; active?: boolean; agent?: boolean }) {
  const updateBrowser = useShell((state) => state.updateBrowser)
  /**
   * 这一页现在是不是浮在窗口上。
   *
   * 视图只有一个，位置也只有一个：页面归列，列来摆；页面归画中画，画中画来摆。
   * 两边都问 store 是为了不让它们抢——两个地方同时 `set_position`，页面会
   * 在列和浮窗之间来回跳。
   */
  const floating = useShell((state) => state.browserPip?.tab === path)
  const dockOpen = useShell((state) => state.browserOpen)
  const toggleBrowserPip = useShell((state) => state.toggleBrowserPip)
  const [loading, setLoading] = useState(false)
  const [importRequested, setImportRequested] = useState(false)
  const [profileRevision, setProfileRevision] = useState(0)
  const { busy: importing, revision: importRevision } = useBrowserImportStatus()
  useEffect(() => {
    const changed = () => setProfileRevision(value => value + 1)
    window.addEventListener("orbit:browser-profile-changed", changed)
    return () => window.removeEventListener("orbit:browser-profile-changed", changed)
  }, [])
  /** Whether the field currently holds something the user typed. */
  const [drafting, setDrafting] = useState(false)
  /**
   * The address field is deliberately **uncontrolled while it is being edited**.
   *
   * Everything that made this feel broken came from React owning the text: the
   * poll reads the page every 1.5s, a navigation writes the URL, and a re-render
   * put the old address back into the field the user was deleting. A browser's
   * address bar is a place you type into; the page can update it only when you
   * are not.
   */
  const address = useRef<HTMLInputElement | null>(null)
  const editing = useRef(false)
  const [failure, setFailure] = useState<string | null>(null)
  const stage = useRef<HTMLDivElement | null>(null)
  /**
   * The last box this tab told the app about.
   *
   * Needed on the way out: a view is hidden at the rectangle it was last placed
   * at, and by the time this component unmounts the layout that produced that
   * rectangle is gone.
   */
  const lastBox = useRef<ViewRect | null>(null)
  const live = url !== "" && url !== "about:blank"

  const fail = useCallback((reason: string) => {
    setFailure(reason)
    reportBrowserFailure(`[view] tab ${path} ${reason}`)
  }, [path])

  // A new tab opens with the caret in the address bar — the field is the only
  // way in now that the empty state is just the logo.
  useEffect(() => {
    if (live) return
    address.current?.focus()
  }, [live])

  // This tab is the one the agent's channel talks to while it is in front. Every
  // tab stays mounted now (a page outlives the pane it was opened from), so this
  // follows "in front", not mount order.
  useEffect(() => {
    if (!active) return
    void browserViewActivate(path).catch(() => undefined)
  }, [path, active])

  /** Place the view where this pane's content area is. */
  useEffect(() => {
    if (floating || importing) return
    const surface = claimBrowserSurface(path)
    let frame = 0
    let cancelled = false
    /** The last box the app was told about, so an unchanged layout costs nothing. */
    let last = ""
    const place = () => {
      frame = 0
      // 页面在浮的时候由画中画来摆，这里必须让位。
      if (floating) return
      const element = stage.current
      if (!element) return
      const rect = element.getBoundingClientRect()
      // 收起的面板量到的是 0×0（切到设置/笔记这类整页界面时网格只是 `hidden`）：
      // 原生子视图不是页面布局的一部分，没人报告矩形它就会浮在别的界面上。这里
      // 主动 hide —— 只是隐藏，页面本身、滚动和登录态都留着，回来重新 show 同一页。
      if (rect.width < 1 || rect.height < 1) {
        // A collapsed browser remains a valid task surface. Create/keep its
        // native page hidden, so navigation and DOM work need not reopen UI.
        if (agent) {
          const parked = lastBox.current ?? { x: -10000, y: -10000, width: 1120, height: 780 }
          const key = `background:${url}`
          if (last === key) return
          last = key
          void surface.present(parked, url || undefined, false, true).catch(error => fail(`后台视图不可用：${error instanceof Error ? error.message : String(error)}`))
          return
        }
        const parked = lastBox.current
        if (!parked || last === "hidden") return
        last = "hidden"
        void surface.present(parked, undefined, false).catch(() => undefined)
        return
      }
      const box: ViewRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      lastBox.current = box
      const key = `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}`
      if (key === last) return
      last = key
      // A task may request only an open browser. Its blank tab still needs a real
      // view; otherwise the driver waits for a view the frontend refuses to create.
      void surface.present(box, url || undefined, live || agent)
        .then(status => {
          if (cancelled || !status) return
          setLoading(status.loading)
          setFailure(null)
        })
        .catch(error => fail(`视图不可用：${error instanceof Error ? error.message : String(error)}`))
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(place)
    }
    schedule()
    const observer = new ResizeObserver(schedule)
    if (stage.current) observer.observe(stage.current)
    window.addEventListener("resize", schedule)
    // A pane that slides in when a split creates it changes its *position* with
    // its size unchanged, and a ResizeObserver only reports size: measuring once
    // left the view parked where the animation happened to be (measured: a page
    // hanging to the right of its pane). So the rect is re-measured for a moment
    // after mount, and again whenever any animation in the app ends.
    const until = performance.now() + 1_200
    let follow = 0
    const trail = () => {
      schedule()
      if (performance.now() < until) follow = window.requestAnimationFrame(trail)
    }
    follow = window.requestAnimationFrame(trail)
    const onAnimationEnd = () => schedule()
    document.addEventListener("animationend", onAnimationEnd, true)
    // A native view is a sibling of the page, not part of its layout, so nothing
    // about React can notice that it drifted. Measured: a view left 1012 device
    // pixels wide in a 698 pixel pane — the page laid out wider than the panel
    // and its right side was cut off, which reads as "the buttons don't work".
    // One cheap check per second makes a stale rectangle impossible; an unchanged
    // box costs nothing (`place` returns early).
    const poll = window.setInterval(schedule, 1_000)
    return () => {
      cancelled = true
      observer.disconnect()
      window.removeEventListener("resize", schedule)
      document.removeEventListener("animationend", onAnimationEnd, true)
      window.clearInterval(poll)
      if (frame) window.cancelAnimationFrame(frame)
      if (follow) window.cancelAnimationFrame(follow)
      surface.release()
    }
  }, [path, url, live, agent, fail, floating, dockOpen, profileRevision, importing, importRevision])

  // The page owns the address while the field is not being edited: the field is
  // written by code, never by a re-render.
  useEffect(() => {
    const element = address.current
    if (!element || editing.current) return
    if (element.value !== url) element.value = url
  }, [url])

  // The page is the authority on its own address and title.
  useEffect(() => {
    if (!live || importing) return
    let cancelled = false
    let reported = false
    const read = async () => {
      const page = await browserViewPage(path).catch(error => {
        const message = error instanceof Error ? error.message : String(error)
        // The first read can arrive before the view exists: the placement effect
        // creates it in the same tick. That is a state, not a failure — and
        // reporting it left a banner on screen that nothing ever cleared.
        if (message.includes("尚未打开")) return null
        if (!reported) {
          reported = true
          fail(`无法读取页面信息：${message}`)
        }
        return null
      })
      if (cancelled) return
      // A successful read also clears a stale banner: a transient failure must
      // not leave "无法读取页面信息" on screen for the rest of the session.
      if (page) setFailure(null)
      if (!page) return
      setLoading(page.loading)
      if (page.title || page.url) updateBrowser(path, { ...(page.title ? { title: page.title } : {}), ...(page.url ? { url: page.url } : {}), ...(page.audioMuted !== undefined ? { audioMuted: page.audioMuted } : {}) })
    }
    void read()
    const timer = window.setInterval(() => void read(), 1_500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [path, live, fail, updateBrowser, importing, importRevision])

  const run = (label: string, action: () => Promise<unknown>) => {
    void action().catch(error => fail(`${label}失败：${error instanceof Error ? error.message : String(error)}`))
  }

  const go = (value: string) => {
    const target = normalizeAddress(value)
    if (!target) return
    if (target === url) { run("刷新页面", () => browserViewReload(path)); return }
    // The owning surface places and navigates the page when its URL changes.
    // This also handles an address entered while the page is floating in PiP.
    updateBrowser(path, { url: target })
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 min-w-0 shrink-0 items-center gap-0.5 border-b border-stroke px-1.5">
        <TabIcon label="后退" disabled={!live} onClick={() => run("后退", () => browserViewGo(path, "back"))}>
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        </TabIcon>
        <TabIcon label="前进" disabled={!live} onClick={() => run("前进", () => browserViewGo(path, "forward"))}>
          <ArrowRight className="size-3.5" strokeWidth={1.75} />
        </TabIcon>
        <TabIcon
          label={loading ? "停止加载" : "重新加载"}
          disabled={!live}
          onClick={() => run(loading ? "停止加载" : "重新加载", () => (loading ? browserViewStop(path) : browserViewReload(path)))}
        >
          {loading ? <X className="size-3.5" strokeWidth={1.75} /> : <RefreshCw className="size-3.5" strokeWidth={1.75} />}
        </TabIcon>
        <form
          className="min-w-0 flex-1"
          onSubmit={event => {
            event.preventDefault()
            go(address.current?.value ?? "")
            address.current?.blur()
          }}
        >
          <div className="flex h-6.5 min-w-0 items-center gap-1.5 rounded-md bg-content/5 px-2">
            {live ? <Globe className="size-3 shrink-0 text-content/40" strokeWidth={1.75} /> : null}
            <input
              ref={address}
              data-browser-address
              defaultValue={url}
              onFocus={event => {
                editing.current = true
                event.currentTarget.select()
              }}
              onBlur={event => {
                editing.current = false
                // Leaving the field (or reloading it) shows the page's own
                // address again — never a half-deleted one.
                event.currentTarget.value = url
                setDrafting(false)
              }}
              onChange={() => setDrafting(true)}
              onKeyDown={event => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  go(event.currentTarget.value)
                  event.currentTarget.blur()
                  return
                }
                if (event.key !== "Escape") return
                event.preventDefault()
                event.currentTarget.value = url
                event.currentTarget.blur()
              }}
              spellCheck={false}
              autoComplete="off"
              aria-label="浏览器地址"
              placeholder="输入网址或搜索词，回车打开"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
            />
            {title && !drafting ? <span className="max-w-[40%] shrink-0 truncate text-[11px] text-content/35" title={title}>{title}</span> : null}
          </div>
        </form>
        <TabIcon
          label="导入浏览器登录"
          disabled={importing}
          onClick={() => setImportRequested(value => !value)}
        >
          <Settings className="size-3.5" strokeWidth={1.75} />
        </TabIcon>
        <TabIcon
          label={floating ? "收回浏览器列" : "画中画"}
          disabled={!live}
          onClick={() => toggleBrowserPip(path)}
        >
          <AppWindow className="size-3.5" strokeWidth={1.75} />
        </TabIcon>
      </div>
      {/* The banner lives *above* the stage on purpose: the page is a native view
          that covers the stage, so anything rendered inside it would be invisible
          exactly when it matters — which is how a failed toolbar button looked
          like a dead one. */}
      {failure ? (
        <div className="browser-banner" role="alert">
          <span className="min-w-0 flex-1 truncate" title={failure}>{failure}</span>
          <button type="button" className="browser-banner-action" onClick={() => setFailure(null)}>知道了</button>
        </div>
      ) : null}
      {/* Same reason as the banner above: the panel is where a login is needed,
          and a toast at the bottom right is covered by the page's native view. */}
      {/* 所有标签页都常驻（页面不属于 pane），所以导入提示只由前台那个画一次。 */}
      {active ? <BrowserImportPrompt requested={importRequested} onClose={() => setImportRequested(false)} /> : null}
      <div ref={stage} role="application" aria-label="浏览器页面" className="browser-stage relative min-h-0 min-w-0 flex-1 overflow-hidden outline-none">
        {!live ? <BrowserStart /> : null}
        {/* 页面在浮的时候，这里是空的：那一页画在窗口上层，别处的画中画卡片里。 */}
        {live && floating ? (
          <div className="absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-2 text-content/40">
              <AppWindow className="size-6" strokeWidth={1.5} />
              <span className="text-[12px]">这一页在画中画里</span>
              <button
                type="button"
                onClick={() => toggleBrowserPip(path)}
                className="rounded-md border border-stroke px-2 py-1 text-[12px] text-content/60 hover:bg-content/5 hover:text-content"
              >
                收回列里
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** A new tab is the app's face and nothing else: the address bar above is
 * where a page is opened, exactly as in a browser. */
function BrowserStart() {
  return (
    <div className="browser-start">
      <img src="/orbit-mark.png" alt="Orbit" className="browser-start-mark" draggable={false} />
    </div>
  )
}

function TabIcon({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-6.5 shrink-0 place-items-center rounded-md text-content/50 enabled:hover:bg-content/10 enabled:hover:text-content disabled:opacity-30"
    >
      {children}
    </button>
  )
}
