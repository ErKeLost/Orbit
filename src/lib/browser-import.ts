import { invoke } from "./native"
import { useShell } from "../features/shell/shellStore"
import { browserViewReload } from "./browser-view"

/**
 * Bringing an existing browser session into Orbit's own browser.
 *
 * Orbit's browser is a real Chrome with its own profile (`browser.rs`), on
 * purpose: the column and the agent are then signed in to exactly what was
 * signed in *there*, and nothing else. That isolation is also why a fresh
 * install looks signed out everywhere, which is what this import answers.
 *
 * What travels is the session material — cookies, and the device-bound session
 * records that keep Chrome from culling them. Passwords and autofill do not.
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
  /**
   * Whether a device-bound session came with it. It has to, or Chrome drops the
   * auth cookies — but it is not enough on its own: a bound session needs a
   * private key that never leaves the profile that made it, so those sites
   * (Google among them) still ask for one sign-in.
   */
  deviceBound: boolean
  importedAt: number
}

/** Every installed Chromium-family profile that has cookies to bring over. */
export function browserImportSources(): Promise<ImportSource[]> {
  return invoke<ImportSource[]>("browser_import_sources")
}

/**
 * The whole import: copy the session in, then hand it to the browser the column
 * renders. One command, because the two halves are one outcome — the report it
 * returns is only written once both have landed, so a half-done import cannot
 * claim to be finished.
 */
export function browserImportSession(browser: string, profile: string): Promise<ImportReport> {
  return invoke<ImportReport>("browser_import_session", { browser, profile })
}
/** The last import, or `null` when nothing has ever been imported. */
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
  for (const workspace of useShell.getState().workspaces) {
    for (const pane of Object.values(workspace.panes)) {
      for (const file of pane.files) {
        if (file.browser) void browserViewReload(file.path).catch(() => undefined)
      }
    }
  }
}

/**
 * The whole import, in the order it has to happen.
 *
 * Chrome first (it is the only one that can decrypt its own cookies), then the
 * column's store, then the pages that are already open. The backend does the
 * first two in one command and only reports once both have landed; this adds the
 * third, because a page that loaded before the import is holding a session it no
 * longer has.
 */
export async function importBrowserSession(browser: string, profile: string): Promise<{ report: ImportReport; cookies: number }> {
  const report = await browserImportSession(browser, profile)
  reloadOpenBrowserTabs()
  return { report, cookies: report.cookies }
}
