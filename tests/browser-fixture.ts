import { Window } from "happy-dom"
import { pageScript } from "../src-tauri/resources/browser-use/page-runtime"

export type Snapshot = { url: string; elements: { ref: string; role: string; name: string; value?: string; href?: string }[]; media: Record<string, unknown>[]; omitted: number }
export function browserFixture(html = "") {
  const window = new Window({ url: "https://fixture.test/" })
  const document = window.document
  document.body.innerHTML = html
  let hit: Element | undefined
  window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect(10, 20, 100, 30)
  window.HTMLElement.prototype.scrollIntoView = () => {}
  Object.defineProperty(document, "elementFromPoint", { value: () => hit, configurable: true })
  Object.defineProperty(document, "execCommand", { value: () => false, configurable: true })
  const evaluate = (script: string) => JSON.parse(JSON.stringify(window.eval(script)))
  const run = (operation: string, input: Record<string, unknown> = {}) => {
    const result = evaluate(pageScript(operation, input)) as { ok: boolean; value: unknown; error?: string }
    if (!result.ok) throw new Error(result.error)
    return result.value
  }
  return { window, document, evaluate, run, hit: (element: Element | undefined) => { hit = element }, snapshot: () => run("snapshot") as Snapshot, close: () => window.close() }
}
