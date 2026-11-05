import type { CuaDriver } from "../cua/driver.ts"

/**
 * The paste route for text, after the accessibility write was refused or
 * ignored.
 *
 * agent-desktop's own rule (`scripts/jev/desktop.mjs`, `enterText`) is that text
 * goes in through whichever route the application accepts: a direct value write
 * is one verified call, and only when that does not work does the value go
 * through the clipboard and a paste shortcut. Typing one key per character is
 * never used — it drops characters and capitals.
 *
 * The reason this matters for us is measured, not stylistic: Chromium and
 * Electron inputs answer an accessibility write with success and change nothing
 * (`docs/solutions/runtime-errors/`). A paste is a real key event, so it reaches
 * the renderer's own input path.
 *
 * The clipboard is borrowed, never assumed: what it held is read first and put
 * back after the application has been given a chance to consume the paste. A
 * clipboard that held anything but text cannot be restored through this
 * interface, so it is cleared instead of silently left holding our value.
 */

/** The paste shortcut for this platform. */
export function pasteCombo(): string[] {
  return process.platform === "darwin" ? ["cmd", "v"] : ["ctrl", "v"]
}

export type PasteTarget = {
  /** Snapshot-bound element token of the field the text belongs in. */
  elementToken?: string
  text: string
  pid: number
  windowId: number
}

export type PasteSession = {
  /** Put the clipboard back; call after the read-back, never before. */
  restore: () => Promise<void>
}

/**
 * Copy the text and press the paste shortcut.
 *
 * Returns the restore closure rather than restoring here: the application reads
 * the clipboard after the key event, so restoring before the caller's read-back
 * would race it and could paste the previous value instead.
 */
export async function beginPaste(driver: CuaDriver, target: PasteTarget): Promise<PasteSession> {
  const held = await driver.callTool("clipboard_read", { include_text: true }).catch(() => undefined)
  const previous = typeof held?.value?.text === "string" ? held.value.text : undefined
  const restore = async () => {
    if (previous !== undefined) {
      await driver.callTool("clipboard_write", { text: previous }).catch(() => undefined)
      return
    }
    // Nothing restorable (an image, files, or nothing at all): leave no text of
    // ours behind, which is what agent-desktop does as well.
    await driver.callTool("clipboard_clear", {}).catch(() => undefined)
  }
  try {
    await driver.callTool("clipboard_write", { text: target.text })
    await driver.callTool("hotkey", {
      keys: pasteCombo(),
      ...(target.elementToken ? { element_token: target.elementToken } : {}),
      pid: target.pid,
      window_id: target.windowId,
    })
  } catch (error) {
    await restore()
    throw error
  }
  return { restore }
}
