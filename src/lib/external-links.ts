// Links rendered inside Markdown (streamdown and friends) have no way out of the
// Tauri webview: plain navigation is blocked, so a link with nowhere else to go
// silently does nothing. This capture-phase interceptor hands those to the system
// browser via the opener plugin before any renderer-level handler can swallow the
// click.
//
// Two kinds of link are none of its business:
//
// * **mailto:** always the system's — Orbit has no mail surface.
// * **a `data-link-surface="panel"` surface** (the transcript's markdown) has its
//   own destination: the browser column beside the conversation. Its handler runs
//   on bubble, so intercepting here would open a second, unasked-for window in
//   the user's real browser and cancel the panel's own click.
import { isTauri } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

const EXTERNAL_SCHEMES = /^(https?:|mailto:)/i

export function installExternalLinkHandler(): void {
  if (!isTauri()) return
  document.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = (event.target as Element | null)?.closest?.('a[href]')
    const href = anchor?.getAttribute('href') ?? ''
    if (!anchor || !EXTERNAL_SCHEMES.test(href)) return
    if (isPanelLink(anchor, href)) return
    event.preventDefault()
    event.stopPropagation()
    void openUrl(href).catch(() => undefined)
  }, true)
}

/** A web link on a surface that opens it in the app; `mailto:` never is. */
function isPanelLink(anchor: Element, href: string): boolean {
  return !/^mailto:/i.test(href) && Boolean(anchor.closest('[data-link-surface="panel"]'))
}
