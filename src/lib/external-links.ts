// Links rendered inside Markdown (streamdown and friends) have no way out of
// the Tauri webview: plain navigation is blocked, so clicking a chat link
// silently does nothing. This capture-phase interceptor hands external
// http/https/mailto links to the system browser via the opener plugin before
// any renderer-level handler can swallow the click.
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
    event.preventDefault()
    event.stopPropagation()
    void openUrl(href).catch(() => undefined)
  }, true)
}
