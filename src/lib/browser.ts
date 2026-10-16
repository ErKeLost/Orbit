/**
 * What the browser column still needs from the old streaming path.
 *
 * The column itself is an engine view now (`browser-view.ts` + `browser_view.rs`).
 * Chrome and the DevTools protocol remain for the *agent's* runs, and live in
 * the extension (`resources/browser-use/`), not here.
 */

import { invoke } from "./native"

/**
 * Put a column-side failure in the desktop log as well as on screen.
 *
 * The banner tells the user something went wrong; this line is what makes it
 * fixable afterwards, and it is the only place a failed view becomes visible at
 * all (the webview's console does not reach the terminal).
 */
export function reportBrowserFailure(message: string): void {
  void invoke("browser_client_report", { message }).catch(() => undefined)
}

/**
 * Where a bare word goes. Baidu is the default because the column's users are
 * reading Chinese sites; changing this one constant changes the omnibox.
 */
export const SEARCH_TEMPLATE = "https://www.baidu.com/s?wd=%s"

/**
 * The address bar is an omnibox: a URL is a URL, anything else is a search.
 *
 * `https://` is the default scheme, so `example.com/docs` needs no typing —
 * and `baidu` (a single word, no dot, not a host) is looked up rather than
 * turned into the address `https://baidu`, which is what made typing a word
 * look broken.
 */
/** Schemes a browser address bar may carry unchanged. */
const KNOWN_SCHEMES = new Set(["http", "https", "file", "data", "about", "blob", "chrome", "view-source", "ftp", "mailto"])
const SCHEME = /^([a-z][a-z0-9+.-]*):(\/\/)?/i

export function normalizeAddress(input: string): string {
  const value = input.trim()
  if (!value) return ""
  // `localhost:3000` and `example.com:8080/x` also match "word:" — a scheme is
  // only a scheme when it is a known one, or is followed by `//`.
  const scheme = SCHEME.exec(value)
  if (scheme && (scheme[2] === "//" || KNOWN_SCHEMES.has(scheme[1]!.toLowerCase()))) return value
  if (/^localhost(:\d+)?(\/|$)/i.test(value) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(value)) return `http://${value}`
  // A dot (or a port) means the user named a host; anything else is a query.
  if (/^[^\s/]+\.[^\s/]+/.test(value) || /^[^\s/]+:\d+(\/|$)/.test(value)) return `https://${value}`
  return SEARCH_TEMPLATE.replace("%s", encodeURIComponent(value))
}
