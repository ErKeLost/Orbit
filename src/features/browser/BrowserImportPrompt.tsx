import { useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { browserImportSources, browserImportState, importBrowserSession, importSummary, useBrowserImportStatus, type ImportSource } from "../../lib/browser-import"
import { persistState } from "../../lib/persistent"
import { useWorkspace } from "../../lib/store"
import { Select } from "../../shared/ui/controls"

/**
 * The offer to bring an existing browser session into this panel.
 *
 * A banner above the stage, *not* a toast. The panel's page is a native child
 * view drawn over the window, and the app's toast region is `fixed bottom-right`
 * — which is exactly where this panel is. So a toast was raised and covered every
 * single time, and this offer only exists while the panel is open, which is why
 * it could never be seen. `BrowserTab` already learned this once: "anything
 * rendered inside the stage would be invisible exactly when it matters".
 *
 * It comes back on every browser panel until the user either imports or says
 * never again: an unimported browser is signed out of everything, and that is
 * worth repeating. The one way to stop it is the button that says so — a silent
 * dismissal would be indistinguishable from the button being broken, which is
 * the shape this feature already failed in once.
 */
// Re-offer once after fixing the dev/production cookie-store mismatch.
const DISMISS_KEY = "orbit.browserImport.dismissed.v2"

/** Where an import has got to, as the backend reports it. */
type Progress = { done: number; total: number }

function dismissedBefore(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1"
  } catch {
    return false
  }
}

export function BrowserImportPrompt({ requested = false, onClose }: { requested?: boolean; onClose?: () => void }) {
  const desktop = useWorkspace((state) => state.runtimeTarget === "desktop")
  const [dismissed, setDismissed] = useState(dismissedBefore)
  const [offer, setOffer] = useState<ImportSource | null>(null)
  const [sources, setSources] = useState<ImportSource[]>([])
  const { busy, revision } = useBrowserImportStatus()
  const [progress, setProgress] = useState<Progress | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    const pending = listen<Progress>("orbit://browser/import-progress", (event) => setProgress(event.payload))
    return () => {
      void pending.then((unlisten) => unlisten())
    }
  }, [])

  useEffect(() => {
    if (!desktop || (dismissed && !requested) || busy) return
    let cancelled = false
    void (async () => {
      try {
        // Nothing to offer once something has been imported. The backend records
        // it, so an import answers for every panel at once — which a dismissal
        // does not, being about the asking rather than the session.
        const imported = await browserImportState()
        if (cancelled) return
        if (imported && !requested) { setOffer(null); return }
        const sources = await browserImportSources()
        if (cancelled) return
        setSources(sources)
        // Offered for any profile that exists, not only one whose cookie count
        // could be measured. The count is a measurement the backend is allowed to
        // fail at, and treating "unknown" as "nothing to import" is how this
        // offer went missing without a word the first time round.
        const best = sources.find(source => source.browser === imported?.browser && source.profile === imported.profile)
          ?? [...sources].sort((left, right) => (right.cookies ?? -1) - (left.cookies ?? -1))[0]
        setOffer(best ?? null)
        if (!best && requested) setFailure("没有检测到可导入的浏览器资料，请先在来源浏览器登录后重试")
      } catch (error) {
        // A failed attempt to *ask* is the one outcome the user can act on, so it
        // is never swallowed.
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => { cancelled = true }
  }, [desktop, dismissed, revision, requested, busy])

  const stopAsking = () => {
    setDismissed(true)
    setOffer(null)
    try {
      localStorage.setItem(DISMISS_KEY, "1")
    } catch {
      // Storage unavailable: the dismissal holds for this panel at least.
    }
    persistState(DISMISS_KEY, "1")
    onClose?.()
  }

  const run = async () => {
    if (!offer) return
    setFailure(null)
    setProgress(null)
    try {
      const { report } = await importBrowserSession(offer.browser, offer.profile)
      setDone(importSummary(report))
      setOffer(null)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  if (failure) {
    return (
      <div className="browser-banner" role="alert">
        <span className="min-w-0 flex-1 truncate" title={failure}>导入登录失败：{failure}</span>
        <button type="button" className="browser-banner-action" onClick={() => { setFailure(null); setOffer(null); onClose?.() }}>知道了</button>
      </div>
    )
  }
  if (done) {
    return (
      <div className="browser-banner" role="status">
        <span className="min-w-0 flex-1 truncate">{done}</span>
        <button type="button" className="browser-banner-action" onClick={() => { setDone(null); onClose?.() }}>知道了</button>
      </div>
    )
  }
  if (busy) {
    // A percentage needs a total, and the total is only known once Chrome has
    // answered — so the first moments honestly say "准备中" instead of drawing a
    // bar that means nothing.
    const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
    return (
      <div className="browser-banner" role="status">
        <span className="min-w-0 flex-1 truncate">
          正在导入登录… {progress ? progress.done === progress.total ? "正在验证 Cookie…" : `${progress.done} / ${progress.total} · ${percent}%` : "准备中"}
        </span>
        <span
          aria-hidden
          style={{ flex: "none", width: 110, height: 4, borderRadius: 999, overflow: "hidden", background: "color-mix(in srgb, currentColor 20%, transparent)" }}
        >
          <span style={{ display: "block", height: "100%", width: `${percent}%`, background: "currentColor", transition: "width 120ms linear" }} />
        </span>
      </div>
    )
  }
  if (!offer) return null
  const who = `${offer.browser}${offer.account ? ` · ${offer.account}` : ""}`
  return (
    <div className="browser-banner" role="status">
      <span className="min-w-0 flex-1 truncate">
        {who} {offer.cookies === null ? "的浏览器资料" : `里有 ${offer.cookies} 个 Cookie`}，导入到这个面板？
      </span>
      {sources.length > 1 ? <Select
        label="选择要导入的浏览器资料"
        value={`${offer.browser}:${offer.profile}`}
        options={sources.map(source => ({ value: `${source.browser}:${source.profile}`, label: `${source.browser} · ${source.account ?? source.label}` }))}
        onChange={value => setOffer(sources.find(source => `${source.browser}:${source.profile}` === value) ?? null)}
        className="w-44 shrink-0"
        width={320}
      /> : null}
      <button type="button" className="browser-banner-action" onClick={() => void run()}>一键导入</button>
      <button type="button" className="browser-banner-action" onClick={stopAsking}>不再显示</button>
    </div>
  )
}
