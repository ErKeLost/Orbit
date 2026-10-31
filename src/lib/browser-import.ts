import { invoke } from "./native"
import { useShell } from "../features/shell/shellStore"
import { browserViewReload } from "./browser-view"
import { useSyncExternalStore } from "react"

let importSnapshot = { busy: false, revision: 0 }
const importListeners = new Set<() => void>()
const subscribeImport = (listener: () => void) => { importListeners.add(listener); return () => { importListeners.delete(listener) } }
const getImportSnapshot = () => importSnapshot
export function useBrowserImportStatus() { return useSyncExternalStore(subscribeImport, getImportSnapshot) }
function setImportBusy(busy: boolean) {
  importSnapshot = { busy, revision: importSnapshot.revision + (busy ? 0 : 1) }
  for (const listener of importListeners) listener()
}

/**
 * Bringing an existing browser session into Orbit's own browser.
 *
 * The panel and agent share a native WebView cookie store. Import reads a
 * snapshot from the source browser and writes the supported cookies into that
 * store. Device-bound credentials and other browser storage do not travel.
 */

/** One profile a session can be imported from. */
export type ImportSource = {
  browser: string
  profile: string
  label: string
  path: string
  cookies: number | null
  account: string | null
  running: boolean
}

/** What an import actually brought over. */
export type ImportReport = {
  browser: string
  profile: string
  cookies: number
  /** Device-bound private keys cannot be transferred into the panel. */
  deviceBound: boolean
  importedAt: number
  skipped?: number
  skippedDomains?: string[]
  version?: number
  partition?: string
  storeIdentity?: string
}

/** Installed browser profiles supported by the cookie reader. */
export function browserImportSources(): Promise<ImportSource[]> {
  return invoke<ImportSource[]>("browser_import_sources")
}

/**
 * Read supported cookies and verify them in the native panel's cookie store.
 * The report records the destination namespace as well as the source profile.
 */
export function browserImportSession(browser: string, profile: string): Promise<ImportReport> {
  return invoke<ImportReport>("browser_import_session", { browser, profile })
}
/** The last import verified in this app's actual cookie store, or null. */
export function browserImportState(): Promise<ImportReport | null> {
  return invoke<ImportReport | null>("browser_import_state")
}

/**
 * Reload every browser tab that is already open.
 *
 * A page that loaded before the import is holding a session it no longer has:
 * cookies are read per request, so only a new request sees them. Creating a
 * *new* tab would also work, but reloading is what keeps the tab the user is
 * looking at.
 */
export function reloadOpenBrowserTabs(): void {
  window.dispatchEvent(new Event("orbit:browser-profile-changed"))
  // Tabs are the window's, not a workspace's: one list, one pass.
  for (const tab of useShell.getState().browserTabs) {
    void browserViewReload(tab.path).catch(() => undefined)
  }
}

/**
 * The whole import, in the order it has to happen.
 *
 * The backend reads/decrypts a source snapshot and verifies the destination.
 * Reload the existing pages afterwards so their next request uses that store.
 */
export async function importBrowserSession(browser: string, profile: string): Promise<{ report: ImportReport; cookies: number }> {
  if (importSnapshot.busy) throw new Error("已有浏览器导入正在进行，请等它结束")
  setImportBusy(true)
  try {
    const report = await browserImportSession(browser, profile)
    reloadOpenBrowserTabs()
    return { report, cookies: report.cookies }
  } finally {
    // Resume native placement after success or failure; a transient import lock
    // must not leave the browser stuck behind an error banner.
    setImportBusy(false)
    window.dispatchEvent(new Event("orbit:browser-profile-changed"))
  }
}

export function importSummary(report: ImportReport): string {
  return `已验证 ${report.cookies} 个 Cookie${report.skipped ? `，跳过 ${report.skipped} 个` : ""}。部分站点可能仍需重新登录。`
}
